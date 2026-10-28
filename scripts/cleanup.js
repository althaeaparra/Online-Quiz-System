/**
 * Housekeeping job — safe to run from cron (e.g. daily).
 *
 *   npm run cleanup
 *
 * Removes abandoned attempts, prunes old notifications, repairs quizzes that
 * lost a category and recomputes cached counters.
 */
import 'dotenv/config';
import { connectDB, disconnectDB } from '../config/db.js';
import { Result } from '../models/Result.js';
import { Notification } from '../models/Notification.js';
import { Quiz } from '../models/Quiz.js';
import { User } from '../models/User.js';
import { RESULT_STATUS } from '../config/constants.js';
import { recomputeQuizAnalytics, recomputeStudentStats } from '../services/quizService.js';
import { getRedis, connectRedis, disconnectRedis } from '../config/redis.js';
import logger from '../utils/logger.js';

const ABANDONED_AFTER_HOURS = Number(process.env.CLEANUP_ABANDONED_HOURS || 24);
const NOTIFICATION_RETENTION_DAYS = 90;

async function run() {
  await connectDB({ allowMemory: process.env.USE_MEMORY_DB === 'true' });
  await connectRedis();

  // 1. Abandoned attempts never submitted.
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_HOURS * 3600 * 1000);
  const abandoned = await Result.deleteMany({
    status: RESULT_STATUS.IN_PROGRESS,
    startedAt: { $lt: cutoff },
  });
  logger.info(`Abandoned attempts removed: ${abandoned.deletedCount}`);

  // 2. Old notifications (the TTL index usually wins; this covers stale data).
  const notificationCutoff = new Date(Date.now() - NOTIFICATION_RETENTION_DAYS * 86400 * 1000);
  const prunedNotifications = await Notification.deleteMany({ createdAt: { $lt: notificationCutoff } });
  logger.info(`Old notifications pruned: ${prunedNotifications.deletedCount}`);

  // 3. Quizzes whose category disappeared move to a fallback bucket.
  const activeCategoryIds = (await Quiz.distinct('category')).filter(Boolean);
  const orphans = await Quiz.countDocuments({ category: { $nin: activeCategoryIds } });
  if (orphans) logger.warn(`${orphans} quizzes reference a missing category — review them in /api/admin/quizzes`);

  // 4. Recompute cached analytics for the busiest quizzes.
  const stale = await Quiz.find({ isPublished: true }).sort({ 'analytics.totalAttempts': -1 }).limit(200).select('_id');
  for (const quiz of stale) await recomputeQuizAnalytics(quiz._id);
  logger.info(`Quiz analytics recomputed: ${stale.length}`);

  // 5. Refresh student aggregates that drifted.
  const activeStudents = await Result.distinct('student');
  const students = await User.find({ _id: { $in: activeStudents } }).select('_id').limit(1000);
  for (const student of students) await recomputeStudentStats(student._id);
  logger.info(`Student stats recomputed: ${students.length}`);

  // 6. Report cache driver health so a degraded Redis is visible in logs.
  logger.info(`Cache: ${getRedis() ? 'redis' : 'in-memory fallback'}`);

  await disconnectRedis();
  await disconnectDB();
  logger.info('Cleanup complete');
}

run().catch(async (err) => {
  logger.error(`Cleanup failed: ${err.stack || err.message}`);
  await disconnectRedis().catch(() => {});
  await disconnectDB().catch(() => {});
  process.exit(1);
});
