/**
 * Idempotent schema/index migration + data backfill.
 *
 *   npm run migrate
 *
 * Runs the model-level sync of indexes, then patches documents created by older
 * versions of the schema so queries and analytics stay consistent.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { Quiz } from '../models/Quiz.js';
import { Subject } from '../models/Subject.js';
import { Category } from '../models/Category.js';
import { Notification } from '../models/Notification.js';
import { QUIZ_DEFAULTS } from '../config/constants.js';
import { slugify } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const steps = [];

async function syncIndexes() {
  for (const model of [User, Quiz, Subject, Category, Notification]) {
    await model.syncIndexes();
  }
  steps.push('indexes synchronised');
}

async function backfillUsers() {
  const result = await User.updateMany(
    { $or: [{ 'preferences.privacy': { $exists: false } }, { 'stats.currentStreak': { $exists: false } }] },
    {
      $set: {
        'preferences.theme': 'system',
        'preferences.emailNotifications': true,
        'preferences.privacy.showOnLeaderboard': true,
        'stats.currentStreak': 0,
        'stats.longestStreak': 0,
      },
    },
  );
  steps.push(`users patched: ${result.modifiedCount}`);

  const academics = await User.updateMany(
    { academic: { $exists: false } },
    { $set: { academic: { studentId: '', teacherId: '', section: '', program: '', yearLevel: '', department: '' } } },
  );
  steps.push(`academic profiles backfilled: ${academics.modifiedCount}`);
}

async function backfillCategories() {
  const missing = await Category.find({ $or: [{ slug: { $in: [null, ''] } }, { slug: { $exists: false } }] });
  for (const category of missing) {
    category.slug = slugify(category.name);
    await category.save();
  }
  steps.push(`category slugs backfilled: ${missing.length}`);
}

async function backfillQuizzes() {
  const quizzes = await Quiz.find({
    $or: [
      { slug: { $in: [null, ''] } },
      { slug: { $exists: false } },
      { 'settings.timePerQuestion': { $exists: false } },
      { isArchived: { $exists: false } },
    ],
  }).select('+slug');

  for (const quiz of quizzes) {
    if (!quiz.slug) quiz.slug = `${slugify(quiz.title)}-${quiz._id.toString().slice(-5)}`;
    if (!quiz.settings) quiz.settings = { ...QUIZ_DEFAULTS };
    if (quiz.settings.timePerQuestion === undefined) quiz.settings.timePerQuestion = QUIZ_DEFAULTS.timePerQuestion;
    if (quiz.isArchived === undefined) quiz.isArchived = false;

    // Ensure every question carries default grading metadata.
    quiz.questions.forEach((question) => {
      if (!question.points) question.points = 1;
      if (question.difficulty === undefined) question.difficulty = 'medium';
    });

    await quiz.save();
  }
  steps.push(`quizzes patched: ${quizzes.length}`);
}

async function rebuildCategoryCounts() {
  await Category.updateMany({}, { $set: { quizCount: 0 } });
  const rows = await Quiz.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }]);
  for (const row of rows) {
    await Category.updateOne({ _id: row._id }, { $set: { quizCount: row.count } });
  }
  steps.push(`category quiz counts rebuilt (${rows.length})`);
}

async function migrate() {
  await connectDB({ allowMemory: process.env.USE_MEMORY_DB === 'true' });
  logger.info(`Database: ${mongoose.connection.host}/${mongoose.connection.name}`);

  await syncIndexes();
  await backfillUsers();
  await backfillCategories();
  await backfillQuizzes();
  await rebuildCategoryCounts();

  steps.forEach((step) => logger.info(`✓ ${step}`));
  logger.info('Migration complete');

  await disconnectDB();
}

migrate().catch(async (err) => {
  logger.error(`Migration failed: ${err.stack || err.message}`);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
