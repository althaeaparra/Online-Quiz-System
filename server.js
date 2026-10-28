import 'dotenv/config';
import http from 'node:http';
import app from './app.js';
import { connectDB, disconnectDB, getMongoStatus } from './config/db.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { initRealtime } from './sockets/realtime.js';
import { createRedisSocketAdapter } from './sockets/redisAdapter.js';
import logger from './utils/logger.js';

const PORT = Number(process.env.PORT || 5000);
const NODE_ENV = process.env.NODE_ENV || 'development';

/**
 * Production refuses to boot with placeholder or short JWT secrets: a weak
 * signing key forges every role, including administrator.
 */
function assertProductionConfig() {
  if (NODE_ENV !== 'production') {
    if (!process.env.JWT_ACCESS_SECRET || !process.env.JWT_REFRESH_SECRET) {
      logger.warn('JWT secrets not set — using insecure development defaults.');
    }
    return;
  }

  const problems = [];
  for (const name of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const value = process.env[name] || '';
    if (!value) problems.push(`${name} is not set`);
    else if (value.includes('change-me') || value.length < 32) {
      problems.push(`${name} must be a random string of at least 32 characters`);
    }
  }

  if (!process.env.MONGO_URI) problems.push('MONGO_URI is not set (production never starts its own in-memory database)');

  if (problems.length) {
    problems.forEach((problem) => logger.error(`Refusing to start: ${problem}`));
    process.exit(1);
  }

  if (!process.env.APP_URL) {
    logger.warn('APP_URL is not set — absolute links (QR join URLs, emails) will use the request host instead.');
  }
  if (!process.env.REDIS_URL) {
    logger.warn(
      'REDIS_URL is not set — sessions, rate limits and live quiz sessions stay per-instance. Run a single instance or add Redis.',
    );
  }
  if (process.env.COOKIE_SECURE === 'false') {
    logger.warn('COOKIE_SECURE=false — session cookies are not marked Secure. Only do this behind an HTTP-only internal network.');
  }
  if ((process.env.COOKIE_SAME_SITE || '').toLowerCase() === 'none' && process.env.COOKIE_SECURE === 'false') {
    logger.warn('COOKIE_SAME_SITE=none requires Secure cookies; browsers will drop them. Use lax or enable HTTPS.');
  }
}

async function bootstrap() {
  assertProductionConfig();

  await connectDB({
    allowMemory: process.env.USE_MEMORY_DB === 'true' || NODE_ENV !== 'production',
  });
  await connectRedis();

  // Zero-setup demo: when the server started its own in-memory database and
  // SEED_DEMO=true, populate the demo cohort so the UI has something to show.
  if (process.env.SEED_DEMO === 'true' && getMongoStatus().memory) {
    const { User } = await import('./models/User.js');
    if ((await User.estimatedDocumentCount()) === 0) {
      logger.info('Seeding demo data into the in-memory database…');
      const { seedDatabase } = await import('./scripts/seed-database.js');
      await seedDatabase();
    }
  }

  const server = http.createServer(app);

  // Redis makes realtime span instances; without it the in-memory adapter
  // serves this process only.
  const socketAdapter = await createRedisSocketAdapter();
  initRealtime(server, socketAdapter ? { adapter: socketAdapter.adapter } : {});
  if (socketAdapter) logger.info('Socket.IO Redis adapter attached — realtime is multi-instance');

  server.listen(PORT, () => {
    logger.info(`CITE BrainCheck API listening on http://localhost:${PORT} (${NODE_ENV})`);
    logger.info(`Docs: http://localhost:${PORT}/api/docs · Health: http://localhost:${PORT}/health`);
  });

  const shutdown = async (signal) => {
    logger.info(`${signal} received — shutting down`);
    server.close(async () => {
      await socketAdapter?.close();
      await disconnectRedis();
      await disconnectDB();
      logger.info('Shutdown complete');
      process.exit(0);
    });
    // Do not hang forever on stuck sockets.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection: ${reason?.stack || reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception: ${err.stack || err.message}`);
    process.exit(1);
  });

  return server;
}

bootstrap().catch((err) => {
  logger.error(`Failed to start: ${err.stack || err.message}`);
  process.exit(1);
});

export { bootstrap };
