import { createClient } from 'redis';
import logger from '../utils/logger.js';

/**
 * Redis is *optional*: when REDIS_URL is missing or unreachable the app keeps
 * working through the in-memory fallback in utils/cache.js. That keeps local
 * development and CI dependency-free while production gets a shared store.
 */

let client = null;
let ready = false;
let connecting = null;

export const isRedisEnabled = () =>
  Boolean(process.env.REDIS_URL) && process.env.NODE_ENV !== 'test';

export const isRedisReady = () => ready;

export async function connectRedis() {
  if (!isRedisEnabled() || ready) return null;
  if (connecting) return connecting;

  connecting = (async () => {
    try {
      client = createClient({
        url: process.env.REDIS_URL,
        socket: { reconnectStrategy: (retries) => (retries > 3 ? false : 250 * retries) },
      });

      client.on('error', (err) => {
        ready = false;
        if (logger) logger.warn(`Redis error: ${err.message}`);
      });
      client.on('ready', () => {
        ready = true;
        logger?.info('Redis connected');
      });
      client.on('end', () => {
        ready = false;
      });

      await client.connect();
      ready = true;
      return client;
    } catch (err) {
      logger?.warn(`Redis unavailable (${err.message}); using in-memory store`);
      ready = false;
      client = null;
      return null;
    } finally {
      connecting = null;
    }
  })();

  return connecting;
}

export function getRedis() {
  return ready ? client : null;
}

export async function disconnectRedis() {
  if (client && ready) {
    try {
      await client.quit();
    } catch {
      /* already closed */
    }
  }
  client = null;
  ready = false;
}

export default { connectRedis, getRedis, isRedisReady, isRedisEnabled, disconnectRedis };
