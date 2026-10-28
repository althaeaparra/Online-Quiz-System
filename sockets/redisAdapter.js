import { createAdapter } from '@socket.io/redis-adapter';
import { getRedis } from '../config/redis.js';
import logger from '../utils/logger.js';

/**
 * Cross-instance Socket.IO broadcasts.
 *
 * Socket.IO's Redis adapter forwards room emits (timers, leaderboards,
 * presence, notifications) through Redis pub/sub, and makes
 * `io.in(room).fetchSockets()` see sockets connected to other instances.
 * That is what turns a set of API processes into one realtime room.
 *
 * Returns `null` when Redis is not configured/unreachable — the in-memory
 * adapter then serves a single instance exactly as before.
 */
export async function createRedisSocketAdapter() {
  const base = getRedis();
  if (!base) return null;

  const pubClient = base.duplicate();
  const subClient = base.duplicate();
  const onError = (err) => logger.warn(`Socket.IO Redis adapter error: ${err.message}`);
  pubClient.on('error', onError);
  subClient.on('error', onError);

  try {
    await Promise.all([pubClient.connect(), subClient.connect()]);
  } catch (err) {
    logger.warn(`Socket.IO Redis adapter unavailable (${err.message}); staying single-instance`);
    await Promise.allSettled([pubClient.destroy(), subClient.destroy()]);
    return null;
  }

  return {
    adapter: createAdapter(pubClient, subClient),
    async close() {
      await Promise.allSettled([pubClient.quit(), subClient.quit()]);
    },
  };
}

export default { createRedisSocketAdapter };
