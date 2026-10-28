import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import cookie from 'cookie';
import { Quiz } from '../models/Quiz.js';
import { COOKIE_NAMES, ROLES } from '../config/constants.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { gradeAnswer } from '../services/quizService.js';
import { getLiveSessionStore, LEASE_SECONDS } from './liveSessionStore.js';
import logger from '../utils/logger.js';

/**
 * Realtime quiz sessions.
 *
 * The HTTP API remains the source of truth for grading and persistence; the
 * socket layer adds synchronised timers, live presence and a running
 * leaderboard. All session state lives in the live session store (Redis in
 * production), so a restart or a second instance sees the same deadline and
 * standings, and a lease decides which instance drives the countdown.
 */

const TICK_INTERVAL_MS = 1000;
const MAX_SESSION_SECONDS = 43200;

let defaultIO = null;

export const getIO = () => defaultIO;

const roomFor = (quizId) => `quiz:${quizId}`;
const userRoom = (userId) => `user:${userId}`;

function authenticateSocket(socket, next) {
  try {
    const rawCookie = socket.handshake.headers?.cookie || '';
    const parsed = rawCookie ? cookie.parse(rawCookie) : {};
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      parsed[COOKIE_NAMES.ACCESS];

    if (!token) return next(new Error('Authentication required'));

    const payload = verifyAccessToken(token);
    socket.data.user = {
      id: payload.sub,
      role: payload.role,
      username: payload.username,
    };
    return next();
  } catch {
    return next(new Error('Invalid or expired token'));
  }
}

async function resolveQuiz(quizId) {
  if (!quizId) return null;
  return Quiz.findById(quizId).select('title questions settings isPublished teacher').lean({ virtuals: false });
}

function serialiseTimer(session, now = Date.now()) {
  if (!session) return null;
  const remaining = Math.max(0, Math.round((session.endsAt - now) / 1000));
  return {
    startedAt: session.startedAt,
    endsAt: session.endsAt,
    remainingSeconds: remaining,
    totalSeconds: Math.round((session.endsAt - session.startedAt) / 1000),
  };
}

export function createRealtime(httpServer, options = {}) {
  const {
    store = getLiveSessionStore(),
    adapter,
    instanceId = randomUUID(),
    tickIntervalMs = TICK_INTERVAL_MS,
  } = options;

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, true),
      credentials: true,
    },
    pingTimeout: 25000,
    maxHttpBufferSize: 1e6,
  });

  // With the Redis adapter attached, rooms and broadcasts span every instance.
  if (adapter) io.adapter(adapter);

  io.use(authenticateSocket);

  /* ── room helpers ─────────────────────────────────────────────────────── */

  const presence = async (quizId) => {
    const sockets = await io.in(roomFor(quizId)).fetchSockets();
    return sockets.length;
  };

  async function broadcastParticipants(quizId) {
    if (!quizId) return;
    try {
      const [count, session] = await Promise.all([presence(quizId), store.getSession(quizId)]);
      io.to(roomFor(quizId)).emit('quiz:participants', {
        quizId: String(quizId),
        count,
        online: Boolean(session),
      });
    } catch (err) {
      logger.warn(`presence broadcast failed: ${err.message}`);
    }
  }

  async function broadcastLeaderboard(quizId) {
    const leaderboard = await store.leaderboard(quizId);
    io.to(roomFor(quizId)).emit('quiz:leaderboard', { quizId: String(quizId), leaderboard });
  }

  /* ── ticker: one lease holder per session, resumable after a restart ───── */

  let ticker = null;
  let closing = false;
  const heldLeases = new Set();

  async function tick() {
    let active = [];
    try {
      active = await store.activeSessionIds();
    } catch (err) {
      logger.warn(`live session lookup failed: ${err.message}`);
      return;
    }

    for (const quizId of active) {
      if (closing) return;
      try {
        const session = await store.getSession(quizId);
        if (!session) {
          // Registry entry without state (expired keys): clean it up.
          await store.endSession(quizId);
          heldLeases.delete(quizId);
          continue;
        }

        // Only the lease holder emits ticks, so instances never double-broadcast.
        const owned = await store.holdTicker(quizId, instanceId, LEASE_SECONDS);
        if (!owned) continue;
        heldLeases.add(quizId);

        const timer = serialiseTimer(session);
        io.to(roomFor(quizId)).emit('quiz:timer', { quizId, ...timer });

        if (timer.remainingSeconds <= 0) {
          const leaderboard = await store.leaderboard(quizId);
          io.to(roomFor(quizId)).emit('quiz:ended', { quizId, reason: 'time_up', leaderboard });
          await store.endSession(quizId);
          heldLeases.delete(quizId);
        }
      } catch (err) {
        logger.warn(`live session ${quizId} tick failed: ${err.message}`);
      }
    }
  }

  // Started immediately so a booting instance picks running sessions back up.
  ticker = setInterval(() => {
    tick();
  }, tickIntervalMs);
  ticker.unref?.();

  /* ── socket handlers ──────────────────────────────────────────────────── */

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(userRoom(user.id));
    logger.debug(`socket connected ${socket.id} (${user.username})`);

    socket.on('notification:read', async () => {
      /* clients ack through HTTP; this keeps parity for future push flows */
    });

    socket.on('quiz:join', async ({ quizId } = {}, ack) => {
      try {
        const quiz = await resolveQuiz(quizId);
        if (!quiz || (!quiz.isPublished && user.role === ROLES.STUDENT)) {
          return ack?.({ ok: false, error: 'Quiz not available' });
        }

        socket.join(roomFor(quizId));
        socket.data.quizId = String(quizId);

        const session = await store.getSession(quizId);
        const [participants, leaderboard] = await Promise.all([
          presence(quizId),
          session ? store.leaderboard(quizId) : Promise.resolve([]),
        ]);

        void broadcastParticipants(quizId);

        return ack?.({
          ok: true,
          quiz: { id: String(quiz._id), title: quiz.title, questionCount: quiz.questions.length },
          session: session ? serialiseTimer(session) : null,
          leaderboard,
          participants,
        });
      } catch (err) {
        logger.warn(`quiz:join failed: ${err.message}`);
        return ack?.({ ok: false, error: 'Unable to join this quiz' });
      }
    });

    socket.on('quiz:leave', ({ quizId } = {}) => {
      if (quizId) socket.leave(roomFor(quizId));
      void broadcastParticipants(quizId || socket.data.quizId);
    });

    /** Host starts a synchronised session. */
    socket.on('quiz:start', async ({ quizId, durationSeconds } = {}, ack) => {
      try {
        const quiz = await resolveQuiz(quizId);
        if (!quiz) return ack?.({ ok: false, error: 'Quiz not found' });

        const isOwner = quiz.teacher.toString() === user.id;
        if (!isOwner && user.role !== ROLES.ADMIN) {
          return ack?.({ ok: false, error: 'Only the quiz owner can start a live session' });
        }

        const totalFromQuiz = quiz.settings?.totalTimeLimit
          ? quiz.settings.totalTimeLimit
          : quiz.questions.reduce((sum, q) => sum + (q.timeLimit || quiz.settings?.timePerQuestion || 60), 0);

        const total = Math.min(Number(durationSeconds) || totalFromQuiz, MAX_SESSION_SECONDS);
        const startedAt = Date.now();

        await store.createSession(quizId, {
          hostId: user.id,
          hostName: user.username,
          title: quiz.title,
          startedAt,
          endsAt: startedAt + total * 1000,
        });

        const session = await store.getSession(quizId);
        const timer = serialiseTimer(session);

        io.to(roomFor(quizId)).emit('quiz:started', {
          quizId: String(quizId),
          title: quiz.title,
          ...timer,
        });

        return ack?.({ ok: true, ...timer });
      } catch (err) {
        logger.warn(`quiz:start failed: ${err.message}`);
        return ack?.({ ok: false, error: 'Unable to start the session' });
      }
    });

    /** Live scoring for instant feedback (persistence still happens over HTTP). */
    socket.on('answer:submit', async ({ quizId, questionId, answer } = {}, ack) => {
      try {
        const quiz = await resolveQuiz(quizId);
        if (!quiz) return ack?.({ ok: false, error: 'Quiz not found' });

        const session = await store.getSession(quizId);
        if (session && Date.now() > session.endsAt) {
          return ack?.({ ok: false, error: 'This session has ended' });
        }

        const question = quiz.questions.find((q) => String(q._id) === String(questionId));
        if (!question) return ack?.({ ok: false, error: 'Unknown question' });

        const { isCorrect, needsManualGrading } = gradeAnswer(question, answer);

        if (session) {
          await store.recordAnswer(quizId, {
            userId: user.id,
            username: user.username,
            points: isCorrect ? question.points || 1 : 0,
          });
          await broadcastLeaderboard(quizId);
        }

        return ack?.({
          ok: true,
          questionId,
          isCorrect: needsManualGrading ? null : isCorrect,
          points: isCorrect ? question.points : 0,
          needsManualGrading,
        });
      } catch (err) {
        logger.warn(`answer:submit failed: ${err.message}`);
        return ack?.({ ok: false, error: 'Unable to score that answer' });
      }
    });

    socket.on('quiz:end', async ({ quizId } = {}, ack) => {
      try {
        const session = await store.getSession(quizId);
        if (!session) return ack?.({ ok: false, error: 'No live session' });
        if (session.hostId !== user.id && user.role !== ROLES.ADMIN) {
          return ack?.({ ok: false, error: 'Only the host can end this session' });
        }

        const leaderboard = await store.leaderboard(quizId);
        io.to(roomFor(quizId)).emit('quiz:ended', {
          quizId: String(quizId),
          reason: 'host_ended',
          leaderboard,
        });
        await store.endSession(quizId);
        heldLeases.delete(String(quizId));
        return ack?.({ ok: true });
      } catch (err) {
        logger.warn(`quiz:end failed: ${err.message}`);
        return ack?.({ ok: false, error: 'Unable to end the session' });
      }
    });

    socket.on('disconnecting', () => {
      const quizId = socket.data.quizId;
      if (quizId) setTimeout(() => void broadcastParticipants(quizId), 0);
    });

    socket.on('disconnect', (reason) => {
      logger.debug(`socket disconnected ${socket.id} (${reason})`);
    });
  });

  return {
    io,
    instanceId,
    store,

    /** Graceful shutdown: hand the ticker leases back so another instance takes over at once. */
    async close() {
      if (closing) return;
      closing = true;
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
      for (const quizId of heldLeases) {
        try {
          await store.releaseTicker(quizId, instanceId);
        } catch (err) {
          logger.warn(`could not release ticker for ${quizId}: ${err.message}`);
        }
      }
      heldLeases.clear();
      await new Promise((resolve) => io.close(resolve));
      if (defaultIO === io) defaultIO = null;
    },
  };
}

/** Boot the realtime layer and register it as the process-wide instance. */
export function initRealtime(httpServer, options = {}) {
  const realtime = createRealtime(httpServer, options);
  defaultIO = realtime.io;
  return realtime.io;
}

/** Push a notification to a connected user (used by notificationService). */
export function pushToUser(userId, event, payload) {
  if (!defaultIO) return false;
  defaultIO.to(userRoom(userId)).emit(event, payload);
  return true;
}

export default { initRealtime, createRealtime, getIO, pushToUser };
