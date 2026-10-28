import mongoose from 'mongoose';
import logger from '../utils/logger.js';

/**
 * Mongo connection helper.
 *
 * - Uses MONGO_URI when it is reachable.
 * - In development (USE_MEMORY_DB=true, or when the URI is unreachable) it can
 *   start an ephemeral in-memory MongoDB so the stack runs with zero services.
 */

let memoryServer = null;

mongoose.set('strictQuery', true);
// Note: we intentionally do NOT enable global `sanitizeFilter`. It rewrites
// legitimate operators (`$ne`, `$gte`, `$in`) into `$eq` wrappers, which breaks
// typed queries. User input is validated and stripped by Zod instead, and all
// dynamic filters are built from allow-listed fields.

export function getMongoStatus() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state: states[mongoose.connection.readyState] || 'unknown',
    host: mongoose.connection.host || null,
    name: mongoose.connection.name || null,
    memory: Boolean(memoryServer),
  };
}

async function startMemoryServer() {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  memoryServer = await MongoMemoryServer.create({
    instance: { dbName: 'citebraincheck' },
  });
  return memoryServer.getUri();
}

export async function connectDB({ uri = process.env.MONGO_URI, allowMemory = false } = {}) {
  const options = {
    serverSelectionTimeoutMS: 4000,
    maxPoolSize: Number(process.env.MONGO_POOL_SIZE || 20),
    autoIndex: process.env.NODE_ENV !== 'production',
  };

  const tryConnect = async (connectionString) => {
    await mongoose.connect(connectionString, options);
    logger.info(`MongoDB connected → ${mongoose.connection.host}/${mongoose.connection.name}`);
  };

  try {
    if (!uri) throw new Error('MONGO_URI is not set');
    await tryConnect(uri);
    return mongoose.connection;
  } catch (err) {
    logger.warn(`MongoDB connection failed: ${err.message}`);

    const memoryAllowed =
      allowMemory || process.env.USE_MEMORY_DB === 'true' || process.env.NODE_ENV !== 'production';

    if (!memoryAllowed) throw err;

    logger.warn('Starting in-memory MongoDB (development fallback)…');
    const memoryUri = await startMemoryServer();
    await tryConnect(memoryUri);
    logger.warn('In-memory MongoDB is ephemeral — data is lost on restart.');
    return mongoose.connection;
  }
}

export async function disconnectDB() {
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

export default { connectDB, disconnectDB, getMongoStatus };
