import { jest } from '@jest/globals';
import { createLiveSessionStore } from '../../sockets/liveSessionStore.js';

/**
 * The store is what makes a live session survive a restart and be readable by
 * another instance. Memory semantics are covered directly; the Redis backend is
 * driven through a small in-test client (Redis itself is not available in CI).
 */

const session = (overrides = {}) => ({
  hostId: 'host-1',
  hostName: 'teacher',
  title: 'Live Quiz',
  startedAt: Date.now(),
  endsAt: Date.now() + 60_000,
  ...overrides,
});

describe('live session store (memory backend)', () => {
  test('round-trips a session and lists it as active', async () => {
    const store = createLiveSessionStore();
    const meta = session({ startedAt: 1_700_000_000_000, endsAt: 1_700_000_060_000 });

    await store.createSession('quiz-1', meta);

    expect(store.kind).toBe('memory');
    expect(await store.getSession('quiz-1')).toMatchObject({ ...meta, quizId: 'quiz-1' });
    expect(await store.activeSessionIds()).toEqual(['quiz-1']);
    expect(await store.getSession('missing')).toBeNull();
  });

  test('accumulates answers and ranks by score, then answered, then name', async () => {
    const store = createLiveSessionStore();
    await store.createSession('quiz-1', session());

    await store.recordAnswer('quiz-1', { userId: 'alice', username: 'alice', points: 10 });
    await store.recordAnswer('quiz-1', { userId: 'bob', username: 'bob', points: 5 });
    await store.recordAnswer('quiz-1', { userId: 'bob', username: 'bob', points: 5 });
    await store.recordAnswer('quiz-1', { userId: 'bob', username: 'bob', points: 0 });
    await store.recordAnswer('quiz-1', { userId: 'carol', username: 'carol', points: 0 });

    expect(await store.leaderboard('quiz-1')).toEqual([
      { rank: 1, userId: 'bob', username: 'bob', score: 10, answered: 3 },
      { rank: 2, userId: 'alice', username: 'alice', score: 10, answered: 1 },
      { rank: 3, userId: 'carol', username: 'carol', score: 0, answered: 1 },
    ]);
  });

  test('ending a session clears state so a restart cannot resurrect it', async () => {
    const store = createLiveSessionStore();
    await store.createSession('quiz-1', session());
    await store.recordAnswer('quiz-1', { userId: 'alice', username: 'alice', points: 10 });

    await store.endSession('quiz-1');

    expect(await store.getSession('quiz-1')).toBeNull();
    expect(await store.leaderboard('quiz-1')).toEqual([]);
    expect(await store.activeSessionIds()).toEqual([]);
  });

  test('only one instance holds the ticker lease at a time', async () => {
    const store = createLiveSessionStore();
    await store.createSession('quiz-1', session());

    expect(await store.holdTicker('quiz-1', 'node-a', 5)).toBe(true);
    expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(false);
    // The holder can renew its own lease.
    expect(await store.holdTicker('quiz-1', 'node-a', 5)).toBe(true);

    await store.releaseTicker('quiz-1', 'node-b'); // not the owner: no-op
    expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(false);

    await store.releaseTicker('quiz-1', 'node-a');
    expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(true);
  });

  test('an expired lease is taken over, so a crashed holder cannot stall the timer', async () => {
    const store = createLiveSessionStore();
    await store.createSession('quiz-1', session());

    const clock = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      expect(await store.holdTicker('quiz-1', 'node-a', 5)).toBe(true);
      clock.mockReturnValue(1_700_000_004_000); // 4s later: still leased
      expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(false);
      clock.mockReturnValue(1_700_000_006_000); // 6s later: lease lapsed
      expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});

/* ── Redis command path ─────────────────────────────────────────────────── */

/**
 * Minimal node-redis v4 stand-in covering exactly the commands the store uses.
 * Real Redis is not installed in this environment, so this proves the command
 * composition, key layout and lease semantics without a server.
 */
function createFakeRedis() {
  const data = new Map(); // key -> { type, value, expiresAt }
  let now = Date.now();

  const getEntry = (key) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= now) {
      data.delete(key);
      return null;
    }
    return entry || null;
  };

  const ensure = (key, type) => {
    let entry = getEntry(key);
    if (!entry) {
      entry = {
        type,
        value: type === 'hash' ? new Map() : type === 'set' ? new Set() : null,
        expiresAt: null,
      };
      data.set(key, entry);
    }
    return entry;
  };

  return {
    clock: {
      advance(seconds) {
        now += seconds * 1000;
      },
    },

    async hSet(key, obj) {
      const hash = ensure(key, 'hash').value;
      let added = 0;
      for (const [field, value] of Object.entries(obj)) {
        if (!hash.has(field)) added += 1;
        hash.set(field, String(value));
      }
      return added;
    },

    async hGetAll(key) {
      const entry = getEntry(key);
      return entry ? Object.fromEntries(entry.value) : {};
    },

    async hIncrBy(key, field, increment) {
      const hash = ensure(key, 'hash').value;
      const next = (Number(hash.get(field)) || 0) + Number(increment);
      hash.set(field, String(next));
      return next;
    },

    async sAdd(key, members) {
      const set = ensure(key, 'set').value;
      let added = 0;
      for (const member of [].concat(members)) {
        if (!set.has(String(member))) added += 1;
        set.add(String(member));
      }
      return added;
    },

    async sMembers(key) {
      const entry = getEntry(key);
      return entry ? [...entry.value] : [];
    },

    async sRem(key, members) {
      const entry = getEntry(key);
      if (!entry) return 0;
      let removed = 0;
      for (const member of [].concat(members)) {
        if (entry.value.delete(String(member))) removed += 1;
      }
      return removed;
    },

    async set(key, value, options = {}) {
      if (options.NX && getEntry(key)) return null;
      data.set(key, {
        type: 'string',
        value: String(value),
        expiresAt: options.EX ? now + options.EX * 1000 : null,
      });
      return 'OK';
    },

    async get(key) {
      const entry = getEntry(key);
      return entry ? entry.value : null;
    },

    async expire(key, seconds) {
      const entry = getEntry(key);
      if (!entry) return 0;
      entry.expiresAt = now + seconds * 1000;
      return 1;
    },

    async del(keys) {
      let removed = 0;
      for (const key of [].concat(keys)) {
        if (getEntry(key)) removed += 1;
        data.delete(key);
      }
      return removed;
    },
  };
}

describe('live session store (redis backend)', () => {
  test('persists timer state, standings and the active registry in Redis keys', async () => {
    const redis = createFakeRedis();
    const store = createLiveSessionStore({ client: redis, prefix: 'test:live' });
    const meta = session({ startedAt: 1_700_000_000_000, endsAt: 1_700_000_060_000 });

    expect(store.kind).toBe('redis');
    await store.createSession('quiz-1', meta);

    expect(await store.getSession('quiz-1')).toEqual({
      quizId: 'quiz-1',
      hostId: 'host-1',
      hostName: 'teacher',
      title: 'Live Quiz',
      startedAt: 1_700_000_000_000,
      endsAt: 1_700_000_060_000,
    });
    expect(await store.activeSessionIds()).toEqual(['quiz-1']);

    await store.recordAnswer('quiz-1', { userId: 'alice', username: 'alice', points: 10 });
    await store.recordAnswer('quiz-1', { userId: 'alice', username: 'alice', points: 5 });
    await store.recordAnswer('quiz-1', { userId: 'bob', username: 'bob', points: 0 });

    expect(await store.leaderboard('quiz-1')).toEqual([
      { rank: 1, userId: 'alice', username: 'alice', score: 15, answered: 2 },
      { rank: 2, userId: 'bob', username: 'bob', score: 0, answered: 1 },
    ]);
  });

  test('a second store on the same Redis sees the session (shared instance state)', async () => {
    const redis = createFakeRedis();
    const writer = createLiveSessionStore({ client: redis, prefix: 'test:live' });
    const reader = createLiveSessionStore({ client: redis, prefix: 'test:live' });

    await writer.createSession('quiz-1', session({ endsAt: 1_700_000_060_000 }));
    await writer.recordAnswer('quiz-1', { userId: 'alice', username: 'alice', points: 10 });

    expect(await reader.getSession('quiz-1')).toMatchObject({ endsAt: 1_700_000_060_000 });
    expect(await reader.leaderboard('quiz-1')).toEqual([
      { rank: 1, userId: 'alice', username: 'alice', score: 10, answered: 1 },
    ]);

    await reader.endSession('quiz-1');

    expect(await writer.getSession('quiz-1')).toBeNull();
    expect(await writer.activeSessionIds()).toEqual([]);
  });

  test('starting a new session resets the previous standings', async () => {
    const redis = createFakeRedis();
    const store = createLiveSessionStore({ client: redis, prefix: 'test:live' });

    await store.createSession('quiz-1', session());
    await store.recordAnswer('quiz-1', { userId: 'alice', username: 'alice', points: 10 });
    await store.createSession('quiz-1', session());

    expect(await store.leaderboard('quiz-1')).toEqual([]);
  });

  test('leases use SET NX and expire so a dead instance is replaced', async () => {
    const redis = createFakeRedis();
    const store = createLiveSessionStore({ client: redis, prefix: 'test:live' });
    await store.createSession('quiz-1', session());

    expect(await store.holdTicker('quiz-1', 'node-a', 5)).toBe(true);
    expect(await store.holdTicker('quiz-1', 'node-a', 5)).toBe(true); // renewal
    expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(false);

    redis.clock.advance(6);
    expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(true);

    await store.releaseTicker('quiz-1', 'node-a'); // stale owner: no-op
    expect(await store.holdTicker('quiz-1', 'node-b', 5)).toBe(true);
  });
});
