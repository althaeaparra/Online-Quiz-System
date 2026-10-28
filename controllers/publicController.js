import { Category } from '../models/Category.js';
import { Quiz } from '../models/Quiz.js';
import { User } from '../models/User.js';
import { Result } from '../models/Result.js';
import { ROLES } from '../config/constants.js';
import { asyncHandler } from '../utils/errors.js';
import { publicUser, round } from '../utils/helpers.js';
import { ok } from '../utils/response.js';

/** GET /api/categories — active categories with published quiz counts. */
export const getCategories = asyncHandler(async (_req, res) => {
  const [categories, counts] = await Promise.all([
    Category.find({ isActive: true }).sort({ order: 1, name: 1 }).lean({ virtuals: false }),
    Quiz.aggregate([
      { $match: { isPublished: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);

  const countMap = new Map(counts.map((c) => [c._id.toString(), c.count]));

  return ok(res, categories.map((c) => ({
    // Both keys are exposed so clients can use Mongo-style or plain ids.
    _id: c._id,
    id: c._id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    icon: c.icon,
    color: c.color,
    quizCount: countMap.get(c._id.toString()) || 0,
  })));
});

/** GET /api/leaderboard — all-time points, respecting privacy settings. */
export const getLeaderboard = asyncHandler(async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));

  const users = await User.find({
    role: ROLES.STUDENT,
    'security.isActive': true,
    'preferences.privacy.showOnLeaderboard': { $ne: false },
    'stats.totalPoints': { $gt: 0 },
  })
    .sort({ 'stats.totalPoints': -1, 'stats.averageScore': -1 })
    .limit(limit)
    .select('username profile stats')
    .lean();

  const ranked = users.map((user, index) => ({
    rank: index + 1,
    username: user.username,
    name: [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ') || user.username,
    avatar: user.profile?.avatar || '',
    points: user.stats?.totalPoints || 0,
    averageScore: round(user.stats?.averageScore || 0),
    quizzesTaken: user.stats?.quizzesTaken || 0,
    streak: user.stats?.currentStreak || 0,
  }));

  return ok(res, ranked);
});

/** GET /api/stats — public platform counters for the landing page. */
export const getPlatformStats = asyncHandler(async (_req, res) => {
  const [students, teachers, publishedQuizzes, categories, attempts, [avg]] = await Promise.all([
    User.countDocuments({ role: ROLES.STUDENT, 'security.isActive': true }),
    User.countDocuments({ role: ROLES.TEACHER, 'security.isActive': true }),
    Quiz.countDocuments({ isPublished: true }),
    Category.countDocuments({ isActive: true }),
    Result.countDocuments({ status: { $ne: 'in_progress' } }),
    Quiz.aggregate([
      { $match: { isPublished: true, 'analytics.completedAttempts': { $gt: 0 } } },
      { $group: { _id: null, avg: { $avg: '$analytics.averageScore' } } },
    ]),
  ]);

  return ok(res, {
    students,
    teachers,
    quizzes: publishedQuizzes,
    categories,
    attempts,
    averageScore: round(avg?.avg || 0),
  });
});

/**
 * GET /api/config — public, non-secret client flags.
 * The admin portal button is opt-in (`SHOW_ADMIN_LINK=true`) so public
 * deployments do not advertise it, while internal ones can expose it.
 */
export const getClientConfig = asyncHandler(async (_req, res) =>
  ok(res, {
    appName: process.env.APP_NAME || 'CITE BrainCheck',
    showAdminPortal: process.env.SHOW_ADMIN_LINK === 'true',
  }),
);

/** GET /api/me — convenience alias usable from the SPA. */
export const getSession = asyncHandler(async (req, res) => ok(res, { user: publicUser(req.user) }));

export default { getCategories, getLeaderboard, getPlatformStats, getClientConfig, getSession };
