import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { connectDB, disconnectDB } from '../../config/db.js';
import { User } from '../../models/User.js';
import { Category } from '../../models/Category.js';
import { Quiz } from '../../models/Quiz.js';
import { Subject } from '../../models/Subject.js';
import { Result } from '../../models/Result.js';
import { Notification } from '../../models/Notification.js';

let memoryServer = null;

/** Boot an isolated MongoDB and make sure every index exists. */
export async function setupTestDb() {
  memoryServer = await MongoMemoryServer.create({ instance: { dbName: 'citebraincheck_test' } });
  process.env.MONGO_URI = memoryServer.getUri();
  await connectDB({ uri: memoryServer.getUri(), allowMemory: false });

  await Promise.all([User.init(), Category.init(), Quiz.init(), Subject.init(), Result.init(), Notification.init()]);
  return memoryServer;
}

export async function clearTestDb() {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({})),
  );
}

export async function teardownTestDb() {
  await mongoose.connection.dropDatabase();
  await disconnectDB();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}

/** Create a user directly (bypassing email latency) for auth/role fixtures. */
export async function seedUser({
  username = 'fixture',
  email = `${username}@test.dev`,
  password = 'Password123',
  role = 'student',
  firstName = 'Test',
  academic = null,
} = {}) {
  return User.create({
    username,
    email,
    password,
    role,
    profile: { firstName, lastName: 'User' },
    academic: academic || (role === 'student'
      ? { studentId: `S-${username}`, section: 'BSIT-3A', program: 'BSIT' }
      : { teacherId: `T-${username}`, department: 'CITE' }),
    security: { emailVerified: true },
  });
}

export async function seedCategory({ name = 'General Knowledge', color = '#6366f1' } = {}) {
  return Category.create({ name, color });
}
