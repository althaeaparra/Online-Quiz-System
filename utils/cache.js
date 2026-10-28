import { getRedis } from '../config/redis.js';
import logger from './logger.js';

/**
 * Small cache facade over Redis with an in-process fallback.
 *
 * Supports the subset the API needs: get / set (with TTL), del, incr, expire,
 * sAdd / sMembers / sRem, and JSON helpers. The fallback keeps TTL semantics so
 * behaviour is identical locally and in production (minus cross-process sharing).
 */

const PREFIX = process.env.REDIS_PREFIX || 'citebraincheck:';
const memory = new Map(); // key -> { value, expiresAt|null }
const sets = new Map(); // key -> Set<string>

const fullKey = (key) => (key.startsWith(PREFIX) ? key : `${PREFIX}${key}`);

const memGet = (key) => {
  const entry = memory.get(key);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt <= Date.now()) {
    memory.delete(key);
    return null;
  }
  return entry.value;
};

const memSet = (key, value, ttlSeconds) => {
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
};

// Opportunistic sweep so the fallback does not leak memory in long dev sessions.
if (typeof setInterval === 'function') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of memory) {
      if (entry.expiresAt && entry.expiresAt <= now) memory.delete(key);
    }
  }, 60_000);
  timer.unref?.();
}

export const cache = {
  async get(key) {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.get(fullKey(key));
      } catch (err) {
        logger.warn(`cache.get failed: ${err.message}`);
      }
    }
    return memGet(key);
  },

  async set(key, value, ttlSeconds = 0) {
    const redis = getRedis();
    if (redis) {
      try {
        if (ttlSeconds) await redis.set(fullKey(key), value, { EX: ttlSeconds });
        else await redis.set(fullKey(key), value);
        return true;
      } catch (err) {
        logger.warn(`cache.set failed: ${err.message}`);
      }
    }
    memSet(key, value, ttlSeconds);
    return true;
  },

  async del(...keys) {
    const redis = getRedis();
    if (redis) {
      try {
        if (keys.length) await redis.del(keys.map(fullKey));
        return true;
      } catch (err) {
        logger.warn(`cache.del failed: ${err.message}`);
      }
    }
    keys.forEach((key) => {
      memory.delete(key);
      sets.delete(key);
    });
    return true;
  },

  async incr(key, ttlSeconds = 0) {
    const redis = getRedis();
    if (redis) {
      try {
        const k = fullKey(key);
        const value = await redis.incr(k);
        if (value === 1 && ttlSeconds) await redis.expire(k, ttlSeconds);
        return value;
      } catch (err) {
        logger.warn(`cache.incr failed: ${err.message}`);
      }
    }
    const current = Number(memGet(key) || 0) + 1;
    const existing = memory.get(key);
    memSet(key, String(current), ttlSeconds || (existing?.expiresAt ? undefined : 0));
    return current;
  },

  async expire(key, ttlSeconds) {
    const redis = getRedis();
    if (redis) {
      try {
        await redis.expire(fullKey(key), ttlSeconds);
        return true;
      } catch (err) {
        logger.warn(`cache.expire failed: ${err.message}`);
      }
    }
    const entry = memory.get(key);
    if (entry) entry.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  },

  async ttl(key) {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.ttl(fullKey(key));
      } catch (err) {
        logger.warn(`cache.ttl failed: ${err.message}`);
      }
    }
    const entry = memory.get(key);
    if (!entry) return -2;
    if (!entry.expiresAt) return -1;
    return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000));
  },

  async sAdd(key, ...members) {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.sAdd(fullKey(key), members);
      } catch (err) {
        logger.warn(`cache.sAdd failed: ${err.message}`);
      }
    }
    const set = sets.get(key) || new Set();
    members.forEach((m) => set.add(String(m)));
    sets.set(key, set);
    return members.length;
  },

  async sMembers(key) {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.sMembers(fullKey(key));
      } catch (err) {
        logger.warn(`cache.sMembers failed: ${err.message}`);
      }
    }
    return [...(sets.get(key) || [])];
  },

  async sRem(key, ...members) {
    const redis = getRedis();
    if (redis) {
      try {
        return await redis.sRem(fullKey(key), members);
      } catch (err) {
        logger.warn(`cache.sRem failed: ${err.message}`);
      }
    }
    const set = sets.get(key);
    if (!set) return 0;
    members.forEach((m) => set.delete(String(m)));
    if (!set.size) sets.delete(key);
    return members.length;
  },

  async getJSON(key) {
    const raw = await cache.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  async setJSON(key, value, ttlSeconds = 0) {
    return cache.set(key, JSON.stringify(value), ttlSeconds);
  },

  /** Test-only helper. */
  async flushLocal() {
    memory.clear();
    sets.clear();
  },
};

export default cache;
