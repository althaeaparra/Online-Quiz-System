import { Quiz } from '../models/Quiz.js';
import { Result } from '../models/Result.js';
import { User } from '../models/User.js';
import { Subject } from '../models/Subject.js';
import { ROLES, RESULT_STATUS } from '../config/constants.js';
import { asyncHandler, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { getPagination, paginationMeta, publicUser, round, serialize } from '../utils/helpers.js';
import { ok } from '../utils/response.js';
import { getTeacherAnalytics } from '../services/analyticsService.js';
import { sendQuizReminder } from '../services/notificationService.js';
import { summariseQuiz } from '../services/quizService.js';

/** GET /api/teacher/dashboard */
export const getDashboard = asyncHandler(async (req, res) => {
  const subjectDocs = await Subject.find({ teacher: req.user._id, isArchived: false })
    .select('subjectCode subjectName section students')
    .lean({ virtuals: true });

  const [analytics, recentQuizzes, pendingGrading] = await Promise.all([
    getTeacherAnalytics(req.user._id, { days: 30 }),
    Quiz.find({ teacher: req.user._id })
      .sort({ updatedAt: -1 })
      .limit(5)
      .populate('category', 'name color')
      .populate('subject', 'subjectCode subjectName section')
      .select('title isPublished difficulty analytics settings updatedAt category subject questions._id questions.points questions.timeLimit')
      .lean({ virtuals: true }),
    Result.countDocuments({ teacher: req.user._id, status: RESULT_STATUS.SUBMITTED }),
  ]);

  const rosterIds = new Set();
  let pendingEnrollments = 0;
  for (const subject of subjectDocs) {
    for (const row of subject.students || []) {
      if (row.status === 'pending') pendingEnrollments += 1;
      if (!row.blocked) rosterIds.add(row.student.toString());
    }
  }

  return ok(res, {
    user: publicUser(req.user),
    summary: {
      ...analytics.summary,
      pendingGrading,
      subjects: subjectDocs.length,
      subjectSections: [...new Set(subjectDocs.map((s) => s.section))].length,
      enrolledStudents: rosterIds.size,
      pendingEnrollments,
    },
    recentQuizzes: recentQuizzes.map(summariseQuiz),
    engagement: analytics.engagement,
    topQuizzes: analytics.perQuiz.slice(0, 5),
    hardestQuestions: analytics.hardestQuestions.slice(0, 5),
    recentSubmissions: analytics.recentSubmissions,
  });
});

/** GET /api/teacher/quizzes/:id/analytics */
export const getQuizAnalytics = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findById(req.params.id).populate('category', 'name color');
  if (!quiz) throw new NotFoundError('Quiz');
  if (req.user.role !== ROLES.ADMIN && quiz.teacher.toString() !== req.user._id.toString()) {
    throw new ForbiddenError('You can only view analytics for your own quizzes');
  }

  const [scoreDistribution, questionStats, attempts, timeline] = await Promise.all([
    Result.aggregate([
      { $match: { quiz: quiz._id, status: { $in: [RESULT_STATUS.SUBMITTED, RESULT_STATUS.GRADED] } } },
      {
        $bucket: {
          groupBy: '$score.percentage',
          boundaries: [0, 20, 40, 60, 80, 101],
          default: 'other',
          output: { count: { $sum: 1 } },
        },
      },
    ]),
    Result.aggregate([
      { $match: { quiz: quiz._id, status: { $in: [RESULT_STATUS.SUBMITTED, RESULT_STATUS.GRADED] } } },
      { $unwind: '$answers' },
      {
        $group: {
          _id: '$answers.question',
          text: { $first: '$answers.questionText' },
          type: { $first: '$answers.type' },
          attempts: { $sum: 1 },
          correct: { $sum: { $cond: ['$answers.isCorrect', 1, 0] } },
          avgPoints: { $avg: '$answers.pointsEarned' },
          maxPoints: { $max: '$answers.maxPoints' },
        },
      },
      {
        $project: {
          text: 1,
          type: 1,
          attempts: 1,
          correctRate: { $round: [{ $multiply: [{ $divide: ['$correct', { $max: ['$attempts', 1] }] }, 100] }, 1] },
          avgPoints: { $round: ['$avgPoints', 1] },
          maxPoints: 1,
        },
      },
      { $sort: { correctRate: 1 } },
    ]),
    Result.find({ quiz: quiz._id, status: { $ne: RESULT_STATUS.IN_PROGRESS } })
      .sort({ completedAt: -1 })
      .limit(25)
      .populate('student', 'username profile.firstName profile.lastName profile.avatar')
      .select('student score isPassed status timeSpent attemptNumber completedAt needsManualGrading')
      .lean({ virtuals: true }),
    Result.aggregate([
      { $match: { quiz: quiz._id, completedAt: { $ne: null } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } },
          attempts: { $sum: 1 },
          avgScore: { $avg: '$score.percentage' },
        },
      },
      { $sort: { _id: 1 } },
      { $limit: 60 },
    ]),
  ]);

  const labels = { 0: '0–19%', 20: '20–39%', 40: '40–59%', 60: '60–79%', 80: '80–100%' };

  return ok(res, {
    quiz: serialize(quiz),
    summary: {
      attempts: quiz.analytics.completedAttempts,
      averageScore: quiz.analytics.averageScore,
      passRate: quiz.analytics.passRate,
      averageTimeSpent: quiz.analytics.averageTimeSpent,
      completionRate: quiz.analytics.completionRate,
      questionCount: quiz.questions.length,
      totalPoints: quiz.questions.reduce((sum, q) => sum + q.points, 0),
    },
    scoreDistribution: scoreDistribution.map((b) => ({
      bucket: labels[b._id] || 'other',
      count: b.count,
    })),
    questionStats,
    timeline,
    attempts,
  });
});

/** GET /api/teacher/students — students who have attempted this teacher's quizzes. */
export const listStudents = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const { page, limit, skip } = getPagination(query);

  const quizIds = await Quiz.find({ teacher: req.user._id }).distinct('_id');

  const pipeline = [
    { $match: { quiz: { $in: quizIds }, status: { $ne: RESULT_STATUS.IN_PROGRESS } } },
    {
      $group: {
        _id: '$student',
        attempts: { $sum: 1 },
        averageScore: { $avg: '$score.percentage' },
        bestScore: { $max: '$score.percentage' },
        lastAttemptAt: { $max: '$completedAt' },
        quizzesTaken: { $addToSet: '$quiz' },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'student',
        pipeline: [{ $project: { username: 1, email: 1, profile: 1, stats: 1 } }],
      },
    },
    { $unwind: '$student' },
  ];

  if (query.search) {
    pipeline.push({
      $match: {
        $or: [
          { 'student.username': { $regex: query.search, $options: 'i' } },
          { 'student.email': { $regex: query.search, $options: 'i' } },
        ],
      },
    });
  }

  const countPipeline = [...pipeline, { $count: 'total' }];
  const [{ total = 0 } = {}] = await Result.aggregate(countPipeline);

  pipeline.push({ $sort: { lastAttemptAt: -1 } }, { $skip: skip }, { $limit: limit });

  const rows = await Result.aggregate(pipeline);

  return ok(res, rows.map((row) => ({
    student: row.student,
    attempts: row.attempts,
    quizzesTaken: row.quizzesTaken.length,
    averageScore: round(row.averageScore || 0),
    bestScore: round(row.bestScore || 0),
    lastAttemptAt: row.lastAttemptAt,
  })), { meta: paginationMeta({ page, limit, total }) });
});

/** GET /api/teacher/students/:id — per-student progress inside the teacher's quizzes. */
export const getStudentProgress = asyncHandler(async (req, res) => {
  const student = await User.findById(req.params.id).select('username email profile stats lastLogin createdAt');
  if (!student) throw new NotFoundError('Student');

  const quizIds = await Quiz.find({ teacher: req.user._id }).distinct('_id');
  const results = await Result.find({ student: student._id, quiz: { $in: quizIds } })
    .sort({ completedAt: -1 })
    .populate('quiz', 'title difficulty')
    .lean({ virtuals: false });

  const graded = results.filter((r) => r.status !== RESULT_STATUS.IN_PROGRESS);

  return ok(res, {
    student: publicUser(student),
    attempts: results.length,
    averageScore: round(
      graded.reduce((sum, r) => sum + (r.score?.percentage || 0), 0) / (graded.length || 1),
    ),
    results,
  });
});

/** GET /api/teacher/results — submissions for the teacher's quizzes. */
export const listResults = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const { page, limit, skip } = getPagination(query);

  const quizIds = await Quiz.find({ teacher: req.user._id }).distinct('_id');
  const filter = { quiz: { $in: quizIds } };
  if (query.quiz) filter.quiz = query.quiz;
  if (query.status) filter.status = query.status;

  const [items, total] = await Promise.all([
    Result.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('student', 'username profile.firstName profile.lastName profile.avatar')
      .populate('quiz', 'title difficulty')
      .lean({ virtuals: true }),
    Result.countDocuments(filter),
  ]);

  return ok(res, items.map(serialize), { meta: paginationMeta({ page, limit, total }) });
});

/** GET /api/teacher/grading — essays waiting for a manual grade. */
export const getGradingQueue = asyncHandler(async (req, res) => {
  const quizIds = await Quiz.find({ teacher: req.user._id }).distinct('_id');
  const results = await Result.find({ quiz: { $in: quizIds }, status: RESULT_STATUS.SUBMITTED })
    .sort({ completedAt: 1 })
    .limit(50)
    .populate('student', 'username profile.firstName profile.lastName')
    .populate('quiz', 'title')
    .lean({ virtuals: false });

  return ok(res, results.map((r) => ({
    ...r,
    pendingAnswers: r.answers.filter((a) => a.needsManualGrading).length,
  })));
});

/** POST /api/teacher/quizzes/:id/remind */
export const remindStudents = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw new NotFoundError('Quiz');
  if (req.user.role !== ROLES.ADMIN && quiz.teacher.toString() !== req.user._id.toString()) {
    throw new ForbiddenError('You can only remind students about your own quizzes');
  }
  if (!quiz.isPublished) throw new ForbiddenError('Publish the quiz before sending reminders');

  const outcome = await sendQuizReminder(quiz);
  return ok(res, outcome, { message: `Reminder queued for ${outcome.sent} student(s)` });
});

export default {
  getDashboard,
  getQuizAnalytics,
  listStudents,
  getStudentProgress,
  listResults,
  getGradingQueue,
  remindStudents,
};
