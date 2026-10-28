import { Quiz } from '../models/Quiz.js';
import { Result } from '../models/Result.js';
import { User } from '../models/User.js';
import { Notification } from '../models/Notification.js';
import { RESULT_STATUS } from '../config/constants.js';
import { asyncHandler, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { getPagination, paginationMeta, percentage, publicUser, round, serialize } from '../utils/helpers.js';
import { ok } from '../utils/response.js';
import { startAttempt, submitAttempt, buildResultReview, summariseQuiz } from '../services/quizService.js';
import { getStudentAnalytics } from '../services/analyticsService.js';
import { enrolledSubjectIds } from '../services/subjectService.js';
import { notifyResultPublished } from '../services/notificationService.js';
import { uploadAvatar, publicUrlFor } from '../middleware/upload.js';
import cache from '../utils/cache.js';
import logger from '../utils/logger.js';

/** GET /api/student/dashboard */
export const getDashboard = asyncHandler(async (req, res) => {
  const studentId = req.user._id;

  // Quizzes pinned to a subject only exist for students who joined that subject.
  const subjectScope = { $or: [{ subject: null }, { subject: { $in: await enrolledSubjectIds(studentId) } }] };

  const [recentResults, publishedCount, unread, attemptedIds, featured, stats] = await Promise.all([
    Result.find({ student: studentId, status: { $ne: RESULT_STATUS.IN_PROGRESS } })
      .sort({ completedAt: -1 })
      .limit(5)
      .populate('quiz', 'title difficulty category')
      .lean({ virtuals: false }),
    Quiz.countDocuments({ isPublished: true }),
    Notification.countDocuments({ user: studentId, isRead: false }),
    Result.find({ student: studentId }).distinct('quiz'),
    Quiz.find({ isPublished: true, isFeatured: true, ...subjectScope })
      .sort({ 'analytics.totalAttempts': -1 })
      .limit(3)
      .populate('category', 'name color')
      .select('title description difficulty analytics settings category')
      .lean({ virtuals: true }),
    getStudentAnalytics(studentId, { days: 30 }),
  ]);

  const recommended = await Quiz.find({
    isPublished: true,
    _id: { $nin: attemptedIds },
    ...subjectScope,
  })
    .sort({ createdAt: -1 })
    .limit(6)
    .populate('category', 'name color icon')
    .select('title description difficulty analytics settings tags category createdAt')
    .lean({ virtuals: true });

  const inProgress = await Result.findOne({ student: studentId, status: RESULT_STATUS.IN_PROGRESS })
    .populate('quiz', 'title')
    .lean({ virtuals: false });

  return ok(res, {
    user: publicUser(req.user),
    summary: {
      ...stats.summary,
      currentStreak: req.user.stats?.currentStreak || 0,
      longestStreak: req.user.stats?.longestStreak || 0,
      quizzesAvailable: Math.max(0, publishedCount - attemptedIds.length),
      unreadNotifications: unread,
    },
    recentResults,
    recommended,
    featured,
    inProgress: inProgress
      ? { resultId: inProgress._id, quiz: inProgress.quiz, startedAt: inProgress.startedAt }
      : null,
    weakAreas: stats.byCategory.filter((c) => c.averageScore < 60).slice(0, 3),
  });
});

/** GET /api/student/quizzes */
export const listAvailableQuizzes = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const { page, limit, skip } = getPagination(query);
  const filter = {
    isPublished: true,
    $or: [{ subject: null }, { subject: { $in: await enrolledSubjectIds(req.user._id) } }],
  };

  if (query.search) filter.$text = { $search: query.search };
  if (query.category) filter.category = query.category;
  if (query.difficulty) filter.difficulty = query.difficulty;
  if (query.subject) filter.subject = query.subject;

  const [items, total] = await Promise.all([
    Quiz.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('category', 'name slug color icon')
      .populate('teacher', 'username profile.firstName profile.lastName')
      .select('title description difficulty tags settings analytics category teacher subject createdAt questions._id questions.points questions.timeLimit')
      .populate('subject', 'subjectCode subjectName section')
      .lean({ virtuals: true }),
    Quiz.countDocuments(filter),
  ]);

  const myAttempts = await Result.aggregate([
    { $match: { student: req.user._id, quiz: { $in: items.map((i) => i._id) } } },
    {
      $group: {
        _id: '$quiz',
        attempts: { $sum: 1 },
        best: { $max: '$score.percentage' },
        lastStatus: { $last: '$status' },
      },
    },
  ]);
  const attemptMap = new Map(myAttempts.map((a) => [a._id.toString(), a]));

  return ok(res, items.map((item) => ({
    ...summariseQuiz(item),
    myAttempts: attemptMap.get(item._id.toString())?.attempts || 0,
    bestScore: round(attemptMap.get(item._id.toString())?.best || 0),
    canRetake:
      item.settings?.allowRetakes !== false &&
      (attemptMap.get(item._id.toString())?.attempts || 0) < (item.settings?.maxAttempts || 3),
  })), { meta: paginationMeta({ page, limit, total }) });
});

/** POST /api/student/quizzes/:id/start */
export const startQuiz = asyncHandler(async (req, res) => {
  const { attempt, quiz, deadline, resumed } = await startAttempt({
    quizId: req.params.id,
    studentId: req.user._id,
    ipAddress: req.ip,
  });

  return ok(res, {
    attemptId: attempt._id,
    attemptNumber: attempt.attemptNumber,
    startedAt: attempt.startedAt,
    deadline,
    resumed,
    quiz,
  }, { message: resumed ? 'Resumed your attempt' : 'Attempt started' });
});

/** POST /api/student/quizzes/:id/submit */
export const submitQuiz = asyncHandler(async (req, res) => {
  const { result, quiz, needsManualGrading } = await submitAttempt({
    quizId: req.params.id,
    studentId: req.user._id,
    answers: req.body.answers,
    timeSpent: req.body.timeSpent,
    attemptId: req.body.attemptId,
  });

  if (!needsManualGrading && quiz.settings.showResultsImmediately) {
    await notifyResultPublished({ user: req.user, result, quizTitle: quiz.title });
  }

  const showAnswers = quiz.settings.showCorrectAnswers;
  const review = buildResultReview(result, quiz, { includeAnswers: showAnswers });

  logger.info(`Student ${req.user.username} submitted quiz ${quiz.title} → ${result.score.percentage}%`);

  return ok(res, {
    result: review,
    summary: {
      score: result.score.totalScore,
      maxScore: result.score.maxScore,
      percentage: result.score.percentage,
      passed: result.score.passed,
      correctCount: result.answers.filter((a) => a.isCorrect).length,
      totalQuestions: result.answers.length,
      timeSpent: result.timeSpent,
      needsManualGrading,
    },
    pendingReview: needsManualGrading,
  }, { message: needsManualGrading ? 'Submitted — your teacher will grade the written answers' : 'Quiz submitted' });
});

/** GET /api/student/results */
export const listResults = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const { page, limit, skip } = getPagination(query);

  const filter = { student: req.user._id, status: { $ne: RESULT_STATUS.IN_PROGRESS } };
  if (query.quiz) filter.quiz = query.quiz;
  if (query.status) filter.status = query.status;

  const [items, total] = await Promise.all([
    Result.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('quiz', 'title difficulty category')
      .lean({ virtuals: true }),
    Result.countDocuments(filter),
  ]);

  return ok(res, items.map(serialize), { meta: paginationMeta({ page, limit, total }) });
});

/** GET /api/student/results/:id */
export const getResultDetail = asyncHandler(async (req, res) => {
  const result = await Result.findById(req.params.id).populate('quiz');
  if (!result) throw new NotFoundError('Result');
  if (result.student.toString() !== req.user._id.toString()) {
    throw new ForbiddenError('You can only view your own results');
  }
  if (result.status === RESULT_STATUS.IN_PROGRESS) {
    return ok(res, { inProgress: true, resultId: result._id, startedAt: result.startedAt });
  }

  const quiz = result.quiz;
  const includeAnswers = quiz?.settings?.showCorrectAnswers !== false;

  return ok(res, buildResultReview(result, quiz, { includeAnswers }));
});

/** GET /api/student/stats */
export const getStats = asyncHandler(async (req, res) => {
  const days = Math.min(365, Number(req.query.days) || 90);
  const [analytics, recent, categories] = await Promise.all([
    getStudentAnalytics(req.user._id, { days }),
    Result.find({ student: req.user._id, status: { $ne: RESULT_STATUS.IN_PROGRESS } })
      .sort({ completedAt: -1 })
      .limit(20)
      .populate('quiz', 'title difficulty category')
      .lean({ virtuals: false }),
    Quiz.aggregate([
      { $match: { isPublished: true } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]),
  ]);

  const attemptedCategories = new Set(
    recent.map((r) => r.quiz?.category?.toString()).filter(Boolean),
  );

  return ok(res, {
    ...analytics,
    streak: {
      current: req.user.stats?.currentStreak || 0,
      longest: req.user.stats?.longestStreak || 0,
    },
    coverage: {
      categoriesAvailable: categories.length,
      categoriesAttempted: attemptedCategories.size,
      percent: percentage(attemptedCategories.size, categories.length || 1),
    },
  });
});

/** PUT /api/student/profile */
export const updateProfile = asyncHandler(async (req, res) => {
  const { profile = {}, preferences = {}, academic = {} } = req.body;

  const user = await User.findById(req.user._id);
  if (!user) throw new NotFoundError('User');

  if (profile) {
    user.profile = { ...user.profile.toObject(), ...profile };
  }
  if (academic && Object.keys(academic).length) {
    // Student / teacher identifiers stay immutable; only cohort details change.
    user.academic = { ...(user.academic?.toObject?.() || {}), ...academic };
  }
  if (preferences) {
    user.preferences = {
      ...user.preferences.toObject(),
      ...preferences,
      privacy: { ...user.preferences.privacy?.toObject?.(), ...(preferences.privacy || {}) },
    };
  }

  await user.save();
  return ok(res, publicUser(user), { message: 'Profile updated' });
});

/** POST /api/student/avatar */
export const uploadUserAvatar = [
  uploadAvatar,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new NotFoundError('Uploaded file');
    const url = publicUrlFor(req.file);
    const user = await User.findById(req.user._id);
    user.profile.avatar = url;
    await user.save();
    return ok(res, { avatar: url, user: publicUser(user) }, { message: 'Avatar updated' });
  }),
];

/** GET /api/student/notifications */
export const getNotifications = asyncHandler(async (req, res) => {
  const { listNotifications } = await import('../services/notificationService.js');
  const { items, unread, meta } = await listNotifications(req.user._id, req.query);
  return ok(res, items, { meta: { ...meta, unread } });
});

/** PATCH /api/student/notifications/:id/read */
export const readNotification = asyncHandler(async (req, res) => {
  const { markNotificationRead } = await import('../services/notificationService.js');
  const notification = await markNotificationRead(req.user._id, req.params.id);
  return ok(res, serialize(notification));
});

/** PATCH /api/student/notifications/read-all */
export const readAllNotifications = asyncHandler(async (req, res) => {
  const { markAllRead } = await import('../services/notificationService.js');
  const count = await markAllRead(req.user._id);
  return ok(res, { updated: count }, { message: 'All notifications marked as read' });
});

/** GET /api/student/in-progress */
export const getInProgress = asyncHandler(async (req, res) => {
  const attempts = await Result.find({ student: req.user._id, status: RESULT_STATUS.IN_PROGRESS })
    .populate('quiz', 'title settings')
    .lean({ virtuals: false });

  const items = await Promise.all(
    attempts.map(async (attempt) => {
      const deadline = await cache.getJSON(`attempt:${attempt._id}`);
      return {
        resultId: attempt._id,
        quiz: attempt.quiz,
        startedAt: attempt.startedAt,
        deadline: deadline?.deadline || null,
        totalSeconds: deadline?.totalSeconds || null,
      };
    }),
  );

  return ok(res, items);
});

export default {
  getDashboard,
  listAvailableQuizzes,
  startQuiz,
  submitQuiz,
  listResults,
  getResultDetail,
  getStats,
  updateProfile,
  uploadUserAvatar,
  getNotifications,
  readNotification,
  readAllNotifications,
  getInProgress,
};
