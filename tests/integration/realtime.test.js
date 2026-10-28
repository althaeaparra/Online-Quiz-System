import http from 'node:http';
import { once } from 'node:events';
import { io as ioClient } from 'socket.io-client';
import app from '../../app.js';
import { Quiz } from '../../models/Quiz.js';
import { initRealtime } from '../../sockets/realtime.js';
import { setupTestDb, clearTestDb, teardownTestDb, seedUser, seedCategory } from '../helpers/db.js';

/**
 * Two real Socket.IO clients against a real HTTP server and a real MongoDB.
 * Covers the three behaviours the socket layer exists for: a synchronised
 * countdown, a shared live leaderboard, and host-controlled session ending.
 */

let server;
let ioServer;
let url;
let quiz;
let teacher;
let student;
let teacherSocket;
let studentSocket;

const connectSocket = (cookie) =>
  ioClient(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    timeout: 5000,
    ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
  });

async function login(email) {
  const res = await fetch(`${url}/api/auth/login`, {
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

beforeAll(async () => {
  await setupTestDb();
  await clearTestDb();

  const category = await seedCategory({ name: 'Realtime Science' });
  teacher = await seedUser({ username: 'rteacher', email: 'rteacher@test.dev', role: 'teacher', firstName: 'Rita' });
  student = await seedUser({ username: 'rstudent', email: 'rstudent@test.dev', role: 'student', firstName: 'Sam' });

  quiz = await Quiz.create({
    title: 'Live Timer Quiz',
    category: category._id,
    teacher: teacher._id,
    isPublished: true,
    settings: { timePerQuestion: 30, passingScore: 50 },
    questions: [
      { type: 'multiple_choice', question: 'Pick the letter A', options: [{ text: 'A' }, { text: 'B' }], correctAnswer: 0, points: 10 },
      { type: 'true_false', question: 'The sky is blue.', correctAnswer: true, points: 10 },
    ],
  });

  server = http.createServer(app);
  ioServer = initRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;

  const teacherLogin = await login('rteacher@test.dev');
  const studentLogin = await login('rstudent@test.dev');

  teacherSocket = connectSocket(teacherLogin.cookie);
  studentSocket = connectSocket(studentLogin.cookie);
  await Promise.all([once(teacherSocket, 'connect'), once(studentSocket, 'connect')]);
}, 120000);

afterAll(async () => {
  teacherSocket?.close();
  studentSocket?.close();

  if (ioServer) await new Promise((resolve) => ioServer.close(resolve));
  if (server?.listening) await new Promise((resolve) => server.close(resolve));

  await teardownTestDb();
});

describe('socket authentication', () => {
  test('rejects a connection without a valid session', async () => {
    const anonymous = connectSocket(null);
    const [error] = await once(anonymous, 'connect_error');

    expect(error.message).toMatch(/Authentication required/i);
    anonymous.close();
  });
});

describe('live quiz session', () => {
  test('both authenticated clients join the room and see presence', async () => {
    const [teacherAck, studentAck] = await Promise.all([
      emitAck(teacherSocket, 'quiz:join', { quizId: String(quiz._id) }),
      emitAck(studentSocket, 'quiz:join', { quizId: String(quiz._id) }),
    ]);

    expect(teacherAck).toMatchObject({ ok: true });
    expect(studentAck).toMatchObject({ ok: true });
    expect(teacherAck.quiz).toMatchObject({ title: 'Live Timer Quiz', questionCount: 2 });
    expect(studentAck.session).toBeNull();

    // A second join from the same student re-broadcasts presence to the room.
    const presence = waitFor(teacherSocket, 'quiz:participants');
    await emitAck(studentSocket, 'quiz:join', { quizId: String(quiz._id) });
    expect((await presence).count).toBe(2);
  });

  test('students cannot start a live session', async () => {
    const ack = await emitAck(studentSocket, 'quiz:start', { quizId: String(quiz._id) });

    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/owner/i);
  });

  test('the host starts a countdown both clients receive in sync', async () => {
    const startedForTeacher = waitFor(teacherSocket, 'quiz:started');
    const startedForStudent = waitFor(studentSocket, 'quiz:started');

    const ack = await emitAck(teacherSocket, 'quiz:start', {
      quizId: String(quiz._id),
      durationSeconds: 30,
    });
    expect(ack.ok).toBe(true);

    const [teacherStart, studentStart] = await Promise.all([startedForTeacher, startedForStudent]);

    expect(teacherStart).toMatchObject({ quizId: String(quiz._id), title: 'Live Timer Quiz' });
    expect(teacherStart.remainingSeconds).toBeGreaterThan(25);
    expect(teacherStart.totalSeconds).toBe(30);
    // Both clients were told the same deadline.
    expect(Math.abs(teacherStart.remainingSeconds - studentStart.remainingSeconds)).toBeLessThanOrEqual(1);
    expect(teacherStart.endsAt).toBe(studentStart.endsAt);

    // The server-driven ticker keeps them aligned and counts down.
    const [firstTickTeacher, firstTickStudent] = await Promise.all([
      waitFor(teacherSocket, 'quiz:timer'),
      waitFor(studentSocket, 'quiz:timer'),
    ]);

    expect(Math.abs(firstTickTeacher.remainingSeconds - firstTickStudent.remainingSeconds)).toBeLessThanOrEqual(1);
    expect(firstTickTeacher.remainingSeconds).toBeLessThan(teacherStart.remainingSeconds);

    const secondTick = await waitFor(studentSocket, 'quiz:timer');
    expect(secondTick.remainingSeconds).toBeLessThanOrEqual(firstTickTeacher.remainingSeconds);
    expect(secondTick.endsAt).toBe(teacherStart.endsAt);
  });

  test('live answer feedback updates the leaderboard for everyone', async () => {
    const leaderboardForTeacher = waitFor(teacherSocket, 'quiz:leaderboard');
    const leaderboardForStudent = waitFor(studentSocket, 'quiz:leaderboard');

    const ack = await emitAck(studentSocket, 'answer:submit', {
      quizId: String(quiz._id),
      questionId: String(quiz.questions[0]._id),
      answer: 0,
    });

    expect(ack).toMatchObject({ ok: true, isCorrect: true, points: 10 });

    const [teacherView, studentView] = await Promise.all([leaderboardForTeacher, leaderboardForStudent]);

    expect(teacherView.leaderboard).toEqual(studentView.leaderboard);
    expect(teacherView.leaderboard[0]).toMatchObject({
      rank: 1,
      userId: student._id.toString(),
      score: 10,
      answered: 1,
    });
  });

  test('a wrong answer is marked incorrect and does not raise the score', async () => {
    const leaderboardForTeacher = waitFor(teacherSocket, 'quiz:leaderboard');

    const ack = await emitAck(studentSocket, 'answer:submit', {
      quizId: String(quiz._id),
      questionId: String(quiz.questions[1]._id),
      answer: false, // the correct answer is true
    });

    expect(ack).toMatchObject({ ok: true, isCorrect: false, points: 0 });

    const leaderboard = await leaderboardForTeacher;
    expect(leaderboard.leaderboard[0]).toMatchObject({
      userId: student._id.toString(),
      score: 10,
      answered: 2,
    });
  });

  test('only the host can end the session, and ending notifies the room', async () => {
    const denied = await emitAck(studentSocket, 'quiz:end', { quizId: String(quiz._id) });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/host/i);

    const endedForTeacher = waitFor(teacherSocket, 'quiz:ended');
    const endedForStudent = waitFor(studentSocket, 'quiz:ended');

    const ack = await emitAck(teacherSocket, 'quiz:end', { quizId: String(quiz._id) });
    expect(ack.ok).toBe(true);

    const [teacherEnd, studentEnd] = await Promise.all([endedForTeacher, endedForStudent]);
    expect(teacherEnd).toMatchObject({ reason: 'host_ended' });
    expect(studentEnd).toMatchObject({ reason: 'host_ended' });

    // The session is gone: ending again is rejected.
    const secondEnd = await emitAck(teacherSocket, 'quiz:end', { quizId: String(quiz._id) });
    expect(secondEnd.ok).toBe(false);
    expect(secondEnd.error).toMatch(/no live session/i);
  });
});
