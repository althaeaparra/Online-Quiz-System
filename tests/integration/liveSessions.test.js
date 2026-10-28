import http from 'node:http';
import { once } from 'node:events';
import { io as ioClient } from 'socket.io-client';
import app from '../../app.js';
import { Quiz } from '../../models/Quiz.js';
import { createRealtime } from '../../sockets/realtime.js';
import { createLiveSessionStore } from '../../sockets/liveSessionStore.js';
import { setupTestDb, clearTestDb, teardownTestDb, seedUser, seedCategory } from '../helpers/db.js';

/**
 * Live sessions are held in a shared store (Redis in production), so the
 * deadline, standings and ticker lease survive a process exit and can be read
 * by a second API instance. These tests run two real HTTP + Socket.IO servers
 * over one store — the local stand-in for a Redis-backed pool.
 *
 * Cross-instance *broadcast* (a room emit reaching a socket on another node) is
 * provided by @socket.io/redis-adapter in production and is not exercised here
 * because no Redis server is available in this environment.
 */

let quiz;
let teacher;
let student;
let studentId;
const instances = [];

const waitFor = (socket, event, timeout = 8000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out after ${timeout}ms waiting for "${event}"`));
    }, timeout);
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });

const emitAck = (socket, event, payload, timeout = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No acknowledgement for "${event}"`)), timeout);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });

async function startInstance(store, instanceId, tickIntervalMs = 150) {
  const server = http.createServer(app);
  const realtime = createRealtime(server, { store, instanceId, tickIntervalMs });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const instance = { server, realtime, url: `http://127.0.0.1:${server.address().port}` };
  instances.push(instance);
  return instance;
}

async function stopInstance(instance) {
  const index = instances.indexOf(instance);
  if (index >= 0) instances.splice(index, 1);
  await instance.realtime.close();
  instance.server.closeAllConnections?.();
  await new Promise((resolve) => instance.server.close(() => resolve()));
}

async function login(baseUrl, email) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: 'Password123' }),
  });
  const json = await res.json();
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { cookie, user: json.data.user };
}

async function connect(baseUrl, cookie) {
  const socket = ioClient(baseUrl, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 5000,
    extraHeaders: { Cookie: cookie },
  });
  await once(socket, 'connect');
  return socket;
}

beforeAll(async () => {
  await setupTestDb();
  await clearTestDb();

  const category = await seedCategory({ name: 'Multi-node Science' });
  teacher = await seedUser({ username: 'livetutor', email: 'livetutor@test.dev', role: 'teacher' });
  student = await seedUser({ username: 'livelearner', email: 'livelearner@test.dev', role: 'student' });
  studentId = student._id.toString();

  quiz = await Quiz.create({
    title: 'Cross-node Quiz',
    category: category._id,
    teacher: teacher._id,
    isPublished: true,
    settings: { timePerQuestion: 30, passingScore: 50 },
    questions: [
      { type: 'multiple_choice', question: 'Pick the letter A', options: [{ text: 'A' }, { text: 'B' }], correctAnswer: 0, points: 10 },
      { type: 'true_false', question: 'The sky is blue.', correctAnswer: true, points: 10 },
    ],
  });
}, 120000);

afterAll(async () => {
  for (const instance of [...instances]) await stopInstance(instance);
  await teardownTestDb();
});

describe('live sessions across processes', () => {
  test('a restarted instance resumes the running countdown and standings', async () => {
    const quizId = String(quiz._id);
    const store = createLiveSessionStore();

    /* ── instance A runs the session ───────────────────────────────────── */
    const nodeA = await startInstance(store, 'node-a');
    const teacherLogin = await login(nodeA.url, 'livetutor@test.dev');
    const studentLogin = await login(nodeA.url, 'livelearner@test.dev');
    const hostA = await connect(nodeA.url, teacherLogin.cookie);
    const playerA = await connect(nodeA.url, studentLogin.cookie);

    await emitAck(hostA, 'quiz:join', { quizId });
    await emitAck(playerA, 'quiz:join', { quizId });

    const started = await emitAck(hostA, 'quiz:start', { quizId, durationSeconds: 120 });
    expect(started.ok).toBe(true);
    expect(started.totalSeconds).toBe(120);

    const scored = await emitAck(playerA, 'answer:submit', {
      quizId,
      questionId: String(quiz.questions[0]._id),
      answer: 0,
    });
    expect(scored).toMatchObject({ ok: true, isCorrect: true, points: 10 });

    /* ── instance A goes away without ending the session ───────────────── */
    hostA.close();
    playerA.close();
    await stopInstance(nodeA);

    // State outlives the process: the deadline and scoreboard are still there.
    expect(await store.getSession(quizId)).toMatchObject({ endsAt: started.endsAt });

    /* ── instance B picks the session up ───────────────────────────────── */
    const nodeB = await startInstance(store, 'node-b');
    const hostB = await connect(nodeB.url, teacherLogin.cookie);
    const playerB = await connect(nodeB.url, studentLogin.cookie);
    await emitAck(playerB, 'quiz:join', { quizId });

    const join = await emitAck(hostB, 'quiz:join', { quizId });
    expect(join.ok).toBe(true);
    expect(join.session.endsAt).toBe(started.endsAt);
    expect(join.session.remainingSeconds).toBeGreaterThan(90);
    expect(join.leaderboard[0]).toMatchObject({ rank: 1, userId: studentId, score: 10, answered: 1 });

    // ...and the ticker is running again on the new instance.
    const tick = await waitFor(hostB, 'quiz:timer', 8000);
    expect(tick.endsAt).toBe(started.endsAt);
    expect(tick.remainingSeconds).toBeGreaterThan(85);

    // The reconnected host can still end the session.
    const endedForPlayer = waitFor(playerB, 'quiz:ended');
    const endAck = await emitAck(hostB, 'quiz:end', { quizId });
    expect(endAck.ok).toBe(true);

    const ended = await endedForPlayer;
    expect(ended).toMatchObject({ quizId, reason: 'host_ended' });
    expect(ended.leaderboard[0]).toMatchObject({ userId: studentId, score: 10, answered: 1 });

    expect(await store.getSession(quizId)).toBeNull();
    expect(await store.activeSessionIds()).toEqual([]);

    hostB.close();
    playerB.close();
  }, 60000);

  test('two instances share one session, its deadline and its leaderboard', async () => {
    const quizId = String(quiz._id);
    const store = createLiveSessionStore();
    const nodeA = await startInstance(store, 'pool-a');
    const nodeB = await startInstance(store, 'pool-b');

    const hostLogin = await login(nodeA.url, 'livetutor@test.dev');
    const playerLogin = await login(nodeB.url, 'livelearner@test.dev');

    const hostA = await connect(nodeA.url, hostLogin.cookie);
    const playerB = await connect(nodeB.url, playerLogin.cookie);
    await emitAck(hostA, 'quiz:join', { quizId });

    const started = await emitAck(hostA, 'quiz:start', { quizId, durationSeconds: 90 });
    expect(started.ok).toBe(true);

    // The player is connected to a different process yet sees the same deadline.
    const join = await emitAck(playerB, 'quiz:join', { quizId });
    expect(join.ok).toBe(true);
    expect(join.session.endsAt).toBe(started.endsAt);
    expect(join.session.remainingSeconds).toBeGreaterThan(80);
    expect(join.participants).toBe(1);

    // Scoring on instance B flows into the shared standings.
    const leaderboardForPlayer = waitFor(playerB, 'quiz:leaderboard');
    const ack = await emitAck(playerB, 'answer:submit', {
      quizId,
      questionId: String(quiz.questions[1]._id),
      answer: true,
    });
    expect(ack).toMatchObject({ ok: true, isCorrect: true, points: 10 });
    expect((await leaderboardForPlayer).leaderboard[0]).toMatchObject({
      userId: studentId,
      score: 10,
      answered: 1,
    });

    // Only the lease holder ticks: the second instance must not double-broadcast.
    await expect(waitFor(playerB, 'quiz:timer', 600)).rejects.toThrow(/Timed out/);

    // The host's process ends the session using standings written by instance B.
    const endedForHost = waitFor(hostA, 'quiz:ended');
    const endAck = await emitAck(hostA, 'quiz:end', { quizId });
    expect(endAck.ok).toBe(true);
    expect((await endedForHost).leaderboard[0]).toMatchObject({ userId: studentId, score: 10, answered: 1 });

    // Ended state is shared: instance B reports no session and no standings.
    const afterEnd = await emitAck(playerB, 'quiz:join', { quizId });
    expect(afterEnd.session).toBeNull();
    expect(afterEnd.leaderboard).toEqual([]);

    hostA.close();
    playerB.close();
    await stopInstance(nodeA);
    await stopInstance(nodeB);
  }, 60000);
});
