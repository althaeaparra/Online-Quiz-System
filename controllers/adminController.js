import os from 'node:os';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Quiz } from '../models/Quiz.js';
import { Result } from '../models/Result.js';
import { Category } from '../models/Category.js';
import { Notification } from '../models/Notification.js';
import { ROLES, ROLE_VALUES } from '../config/constants.js';
import { asyncHandler, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { getPagination, paginationMeta, publicUser, serialize, toCsv } from '../utils/helpers.js';
import { ok, created, noContent } from '../utils/response.js';
import { getSystemAnalytics, buildReport } from '../services/analyticsService.js';
import { isRedisReady, isRedisEnabled } from '../config/redis.js';
import { getMongoStatus } from '../config/db.js';

const APP_STARTED_AT = Date.now();

/** GET /api/admin/dashboard */
export const getDashboard = asyncHandler(async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 30);
  const [analytics, recentUsers, recentResults] = await Promise.all([
    getSystemAnalytics({ days }),
    User.find().sort({ createdAt: -1 }).limit(5).select('username email role createdAt security.isActive').lean(),
    Result.find({ status: { $ne: 'in_progress' } })
      .sort({ completedAt: -1 })
      .limit(6)
      .populate('student', 'username')
      .populate('quiz', 'title')
      .lean({ virtuals: false }),
  ]);

  return ok(res, {
    ...analytics,
    recentUsers,
    recentResults,
    health: {
      uptimeSeconds: Math.round((Date.now() - APP_STARTED_AT) / 1000),
      database: getMongoStatus().state,
      cache: isRedisEnabled() ? (isRedisReady() ? 'redis' : 'degraded') : 'in-memory',
    },
  });
});

/* ── users ──────────────────────────────────────────────────────────────── */

/** GET /api/admin/users */
export const listUsers = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const { page, limit, skip } = getPagination(query, { defaultLimit: 20 });

  const filter = {};
  if (query.role) filter.role = query.role;
  if (query.status) filter['security.isActive'] = query.status === 'active';
  if (query.search) {
    filter.$or = [
      { username: { $regex: query.search, $options: 'i' } },
      { email: { $regex: query.search, $options: 'i' } },
    ];
  }

  const [items, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).select('+security').lean(),
    User.countDocuments(filter),
  ]);

  return ok(res, items.map(publicUser), { meta: paginationMeta({ page, limit, total }) });
});

/** GET /api/admin/users/:id */
export const getUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+security');
  if (!user) throw new NotFoundError('User');

  const [results, quizzes] = await Promise.all([
    Result.countDocuments({ student: user._id }),
    Quiz.countDocuments({ teacher: user._id }),
  ]);

  return ok(res, { ...publicUser(user), counts: { results, quizzes } });
});

/** PATCH /api/admin/users/:id */
export const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('+security');
  if (!user) throw new NotFoundError('User');

  const { role, isActive, emailVerified, profile } = req.body;

  if (role && !ROLE_VALUES.includes(role)) throw new ValidationError('Unknown role');
  if (user._id.equals(req.user._id) && (role && role !== ROLES.ADMIN)) {
    throw new ForbiddenError('You cannot demote your own admin account');
  }

  if (role) user.role = role;
  if (typeof isActive === 'boolean') user.security.isActive = isActive;
  if (typeof emailVerified === 'boolean') user.security.emailVerified = emailVerified;
  if (profile) user.profile = { ...user.profile.toObject(), ...profile };

  await user.save();
  return ok(res, publicUser(user), { message: 'User updated' });
});

/** DELETE /api/admin/users/:id — deactivates (never destroys quiz history). */
export const deleteUser = asyncHandler(async (req, res) => {
  if (req.params.id === req.user._id.toString()) {
    throw new ForbiddenError('You cannot deactivate your own account');
  }

  const user = await User.findById(req.params.id).select('+security');
  if (!user) throw new NotFoundError('User');

  if (user.role === ROLES.ADMIN) {
    const admins = await User.countDocuments({ role: ROLES.ADMIN, 'security.isActive': true });
    if (admins <= 1) throw new ConflictError('At least one active admin must remain');
  }

  user.security.isActive = false;
  await user.save();

  return ok(res, { id: user._id, isActive: false }, { message: 'User deactivated' });
});

/** DELETE /api/admin/users/:id/permanent — hard delete (no attempts only). */
export const purgeUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new NotFoundError('User');
  if (req.params.id === req.user._id.toString()) throw new ForbiddenError('You cannot delete your own account');

  const activity = await Result.countDocuments({ student: user._id });
  if (activity > 0) {
    throw new ConflictError('This user has attempt history; deactivate them instead of deleting');
  }

  await Notification.deleteMany({ user: user._id });
  await user.deleteOne();
  return noContent(res);
});

/* ── categories ─────────────────────────────────────────────────────────── */

/** GET /api/admin/categories (also public /api/categories) */
export const listCategories = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.includeInactive !== 'true') filter.isActive = true;

  const categories = await Category.find(filter).sort({ order: 1, name: 1 }).lean({ virtuals: false });

  // Attach live quiz counts so ordering and empty states are accurate.
  const counts = await Quiz.aggregate([
    { $match: { isPublished: true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

  return ok(res, categories.map((c) => ({ ...c, quizCount: countMap.get(c._id.toString()) || 0 })));
});

/** POST /api/admin/categories */
export const createCategory = asyncHandler(async (req, res) => {
  const exists = await Category.findOne({ name: req.body.name });
  if (exists) throw new ConflictError('A category with that name already exists');

  if (req.body.parentCategory) {
    const parent = await Category.findById(req.body.parentCategory);
    if (!parent) throw new NotFoundError('Parent category');
  }

  const category = await Category.create(req.body);
  return created(res, serialize(category));
});

/** PATCH /api/admin/categories/:id */
export const updateCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) throw new NotFoundError('Category');

  if (req.body.parentCategory && req.body.parentCategory === req.params.id) {
    throw new ValidationError('A category cannot be its own parent');
  }

  Object.assign(category, req.body);
  await category.save();
  return ok(res, serialize(category), { message: 'Category updated' });
});

/** DELETE /api/admin/categories/:id */
export const deleteCategory = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.params.id);
  if (!category) throw new NotFoundError('Category');

  const inUse = await Quiz.countDocuments({ category: category._id });
  if (inUse > 0) {
    throw new ConflictError(`${inUse} quiz${inUse === 1 ? '' : 'zes'} still use this category`);
  }

  await category.deleteOne();
  return noContent(res);
});

/* ── quizzes ────────────────────────────────────────────────────────────── */

/** GET /api/admin/quizzes — every quiz, drafts included. */
export const listAllQuizzes = asyncHandler(async (req, res) => {
  const { page, limit, skip } = getPagination(req.query, { defaultLimit: 20 });
  const filter = {};
  if (req.query.search) filter.$text = { $search: req.query.search };
  if (req.query.teacher) filter.teacher = req.query.teacher;
  if (req.query.published) filter.isPublished = req.query.published === 'true';

  const [items, total] = await Promise.all([
    Quiz.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('teacher', 'username')
      .populate('category', 'name color')
      .select('title difficulty isPublished isFeatured analytics createdAt teacher category')
      .lean({ virtuals: true }),
    Quiz.countDocuments(filter),
  ]);

  return ok(res, items.map(serialize), { meta: paginationMeta({ page, limit, total }) });
});

/* ── operations ─────────────────────────────────────────────────────────── */

/** PATCH /api/admin/quizzes/:id/feature */
export const featureQuiz = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw new NotFoundError('Quiz');

  quiz.isFeatured = Boolean(req.body.isFeatured);
  await quiz.save();
  return ok(res, serialize(quiz), { message: quiz.isFeatured ? 'Quiz featured' : 'Quiz unfeatured' });
});

/** GET /api/admin/system-health */
export const systemHealth = asyncHandler(async (_req, res) => {
  const memory = process.memoryUsage();
  const database = getMongoStatus();

  const dbPing = await mongoose.connection.db
    ?.admin()
    .ping()
    .then(() => 'ok')
    .catch(() => 'unreachable');

  const status =
    database.state === 'connected' && dbPing === 'ok' ? 'healthy' : 'degraded';

  return ok(res, {
    status,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    platform: `${os.type()} ${os.release()}`,
    pid: process.pid,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
    database: { ...database, ping: dbPing },
    cache: { driver: isRedisEnabled() ? 'redis' : 'memory', ready: isRedisReady() },
    environment: process.env.NODE_ENV || 'development',
  }, { status: status === 'healthy' ? 200 : 503 });
});

/**
 * Two CSV blocks in one file: the department totals, then one row per subject.
 * Mirrors the Numbers on the admin dashboard's Subjects & enrollment section.
 */
function buildSubjectCsv(report) {
  const s = report.summary || {};

  const totals = [
    ['metric', 'value'],
    ['range_days', report.days],
    ['subjects', s.total || 0],
    ['sections', s.sections || 0],
    ['roster_seats', s.rosterEntries || 0],
    ['active_enrollments', s.activeEnrollments || 0],
    ['pending_enrollments', s.pendingEnrollments || 0],
    ['blocked_enrollments', s.blockedEnrollments || 0],
    ['unique_students', s.uniqueStudents || 0],
    ['qr_codes_live', s.activeQrCodes || 0],
    ['qr_codes_issued', s.qrIssuedInRange || 0],
    ['new_enrollments', s.newEnrollments || 0],
  ];

  const detail = [
    ['subject_code', 'subject_name', 'section', 'program', 'teacher', 'enrolled', 'active', 'pending', 'blocked', 'qr_status', 'qr_expires_at'],
    ...(report.rows || []).map((r) => [
      r.subjectCode,
      r.subjectName,
      r.section,
      r.program,
      r.teacher,
      r.enrolledCount,
      r.activeCount,
      r.pendingCount,
      r.blockedCount,
      r.qrActive ? 'live' : 'off',
      r.qrExpiresAt ? new Date(r.qrExpiresAt).toISOString() : '',
    ]),
  ];

  return `${toCsv(totals)}\r\n\r\n${toCsv(detail)}`;
}

/** GET /api/admin/reports?type=overview|users|quizzes|results|subjects&format=csv */
export const getReports = asyncHandler(async (req, res) => {
  const { type = 'overview', from, to, format } = req.query;
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));

  if (format === 'csv' && type !== 'subjects') {
    throw new ValidationError('CSV export is only available for the subjects report (type=subjects)');
  }

  const report = await buildReport({ type, from, to, days });

  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="subjects-report-${Date.now()}.csv"`);
    // BOM keeps Excel on UTF-8 for accented names.
    return res.status(200).send(`\uFEFF${buildSubjectCsv(report)}`);
  }

  // Results/quizzes reports can be large — send as a download when asked.
  if (req.query.download === 'true') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-report-${Date.now()}.json"`);
    return res.status(200).send(JSON.stringify(report, null, 2));
  }

  return ok(res, report);
});

/** POST /api/admin/notifications/broadcast */
export const broadcast = asyncHandler(async (req, res) => {
  const { title, message, role, link } = req.body;
  if (!title || !message) throw new ValidationError('Title and message are required');

  const filter = { 'security.isActive': true };
  if (role) filter.role = role;

  const users = await User.find(filter).select('_id').limit(5000).lean();
  if (!users.length) return ok(res, { sent: 0 });

  const docs = users.map((u) => ({
    user: u._id,
    type: 'system',
    title,
    message,
    link: link || '',
  }));

  await Notification.insertMany(docs, { ordered: false });
  return ok(res, { sent: docs.length }, { message: `Broadcast sent to ${docs.length} user(s)` });
});

export default {
  getDashboard,
  listUsers,
  getUser,
  updateUser,
  deleteUser,
  purgeUser,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listAllQuizzes,
  featureQuiz,
  systemHealth,
  getReports,
  broadcast,
};
