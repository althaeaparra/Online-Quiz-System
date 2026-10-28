import { getRedis } from '../config/redis.js';
import logger from '../utils/logger.js';

/**
 * Durable state for live quiz sessions.
 *
 * Timers, standings and the per-session ticker lease live here so that:
 *  - a restarting instance can resume a running countdown (state is not in RAM),
 *  - every instance reads the same deadline, scoreboard and session owner,
 *  - only one instance drives the 1s ticker for a session (lease + failover).
 *
 * With `REDIS_URL` configured the Redis backend is used, which is what makes
 * the state shared between processes. Without it the in-memory backend keeps
 * the exact same semantics for single-process development and tests.
 */

const DEFAULT_PREFIX = process.env.LIVE_SESSION_PREFIX || 'citebraincheck:live';
const LEASE_SECONDS = 5;
// Longest session the socket layer allows (12h) plus a grace window for late joins.
const STATE_TTL_SECONDS = 12 * 60 * 60 + 60 * 60;

const memoryBackend = () => {
  const sessions = new Map(); // quizId -> { meta, scores, answered, names }
  const leases = new Map(); // quizId -> { owner, expiresAt }

  const drop = (quizId) => {
    sessions.delete(quizId);
    leases.delete(quizId);
  };

  const leaderboard = (quizId, limit) => {
    const session = sessions.get(quizId);
    if (!session) return [];
    return [...session.scores.entries()]
      .map(([userId, score]) => ({
        userId,
        username: session.names.get(userId) || 'Player',
        score: Number(score) || 0,
        answered: Number(session.answered.get(userId)) || 0,
      }))
      .sort((a, b) => b.score - a.score || b.answered - a.answered || a.username.localeCompare(b.username))
      .slice(0, limit)
      .map((row, index) => ({ rank: index + 1, ...row }));
  };

  return {
    kind: 'memory',

    async createSession(quizId, meta) {
      sessions.set(String(quizId), {
        meta: { quizId: String(quizId), ...meta },
        scores: new Map(),
        answered: new Map(),
        names: new Map(),
      });
      leases.delete(String(quizId));
    },

    async getSession(quizId) {
      const session = sessions.get(String(quizId));
      return session ? { ...session.meta } : null;
    },

    async recordAnswer(quizId, { userId, username, points = 0 }) {
      const session = sessions.get(String(quizId));
      if (!session) return;
      session.scores.set(userId, (Number(session.scores.get(userId)) || 0) + points);
      session.answered.set(userId, (Number(session.answered.get(userId)) || 0) + 1);
      session.names.set(userId, username);
    },

    async leaderboard(quizId, limit = 10) {
      return leaderboard(String(quizId), limit);
    },

    async activeSessionIds() {
      return [...sessions.keys()];
    },

    async endSession(quizId) {
      drop(String(quizId));
    },

    async holdTicker(quizId, ownerId, ttlSeconds) {
      const id = String(quizId);
      const lease = leases.get(id);
      const now = Date.now();
      if (lease && lease.owner !== ownerId && lease.expiresAt > now) return false;
      leases.set(id, { owner: ownerId, expiresAt: now + ttlSeconds * 1000 });
      return true;
    },

    async releaseTicker(quizId, ownerId) {
      const id = String(quizId);
      if (leases.get(id)?.owner === ownerId) leases.delete(id);
    },
  };
};

const redisBackend = (client, prefix) => {
  const activeKey = `${prefix}:active`;
  const keys = (quizId) => ({
    meta: `${prefix}:${quizId}`,
    scores: `${prefix}:${quizId}:scores`,
    answered: `${prefix}:${quizId}:answered`,
    names: `${prefix}:${quizId}:names`,
    lease: `${prefix}:${quizId}:lease`,
  });

  return {
    kind: 'redis',

    async createSession(quizId, meta) {
      const k = keys(quizId);
      await client.del([k.scores, k.answered, k.names, k.lease]);
      await client.hSet(k.meta, {
        hostId: String(meta.hostId),
        hostName: meta.hostName || '',
        title: meta.title || '',
        startedAt: String(meta.startedAt),
        endsAt: String(meta.endsAt),
      });
      await client.expire(k.meta, STATE_TTL_SECONDS);
      await client.sAdd(activeKey, [String(quizId)]);
    },

    async getSession(quizId) {
      const raw = await client.hGetAll(keys(quizId).meta);
      if (!raw || !raw.endsAt) return null;
      return {
        quizId: String(quizId),
        hostId: raw.hostId,
        hostName: raw.hostName,
        title: raw.title,
        startedAt: Number(raw.startedAt),
        endsAt: Number(raw.endsAt),
      };
    },

    async recordAnswer(quizId, { userId, username, points = 0 }) {
      const k = keys(quizId);
      await client.hIncrBy(k.scores, userId, points);
      await client.hIncrBy(k.answered, userId, 1);
      await client.hSet(k.names, { [userId]: username });
      await Promise.all([
        client.expire(k.scores, STATE_TTL_SECONDS),
        client.expire(k.answered, STATE_TTL_SECONDS),
        client.expire(k.names, STATE_TTL_SECONDS),
      ]);
    },

    async leaderboard(quizId, limit = 10) {
      const k = keys(quizId);
      const [scores, answered, names] = await Promise.all([
        client.hGetAll(k.scores),
        client.hGetAll(k.answered),
        client.hGetAll(k.names),
      ]);
      return Object.keys(scores)
        .map((userId) => ({
          userId,
          username: names[userId] || 'Player',
          score: Number(scores[userId]) || 0,
          answered: Number(answered[userId]) || 0,
        }))
        .sort((a, b) => b.score - a.score || b.answered - a.answered || a.username.localeCompare(b.username))
        .slice(0, limit)
        .map((row, index) => ({ rank: index + 1, ...row }));
    },

    async activeSessionIds() {
      return client.sMembers(activeKey);
    },

    async endSession(quizId) {
      const k = keys(quizId);
      await client.del([k.meta, k.scores, k.answered, k.names, k.lease]);
      await client.sRem(activeKey, [String(quizId)]);
    },

    async holdTicker(quizId, ownerId, ttlSeconds) {
      const key = keys(quizId).lease;
      const current = await client.get(key);
      if (current === ownerId) {
        await client.expire(key, ttlSeconds);
        return true;
      }
      if (current) return false;
      const acquired = await client.set(key, ownerId, { NX: true, EX: ttlSeconds });
      return acquired === 'OK';
    },

    async releaseTicker(quizId, ownerId) {
      const key = keys(quizId).lease;
      const current = await client.get(key);
      if (current === ownerId) await client.del([key]);
    },
  };
};

/**
 * @param {object} [options]
 * @param {object|Function} [options.client] Redis client (or a getter returning
 *   one). Defaults to the shared connection, resolved per call so the store
 *   starts working as soon as Redis connects. Passing a client pins the
 *   backend, which is how the Redis path is tested.
 * @param {string} [options.prefix] key namespace
 */
export function createLiveSessionStore({ client, prefix = DEFAULT_PREFIX } = {}) {
  const resolveClient = typeof client === 'function' ? client : () => client || null;
  const memory = memoryBackend();
  let cachedClient = null;
  let cachedRedis = null;

  const backend = () => {
    const redis = resolveClient();
    if (!redis) return memory;
    if (redis !== cachedClient) {
      cachedClient = redis;
      cachedRedis = redisBackend(redis, prefix);
    }
    return cachedRedis;
  };

  return {
    get kind() {
      return backend().kind;
    },
    createSession: (quizId, meta) => backend().createSession(String(quizId), meta),
    getSession: (quizId) => backend().getSession(String(quizId)),
    recordAnswer: (quizId, entry) => backend().recordAnswer(String(quizId), entry),
    leaderboard: (quizId, limit) => backend().leaderboard(String(quizId), limit),
    activeSessionIds: () => backend().activeSessionIds(),
    endSession: (quizId) => backend().endSession(String(quizId)),
    holdTicker: (quizId, ownerId, ttl = LEASE_SECONDS) => backend().holdTicker(String(quizId), ownerId, ttl),
    releaseTicker: (quizId, ownerId) => backend().releaseTicker(String(quizId), ownerId),
  };
}

let sharedStore = null;

/** The store used by the realtime layer in production (Redis when available). */
export function getLiveSessionStore() {
  if (!sharedStore) {
    sharedStore = createLiveSessionStore({ client: () => getRedis(), prefix: DEFAULT_PREFIX });
  }
  return sharedStore;
}

export { LEASE_SECONDS, STATE_TTL_SECONDS };
export default { createLiveSessionStore, getLiveSessionStore };
