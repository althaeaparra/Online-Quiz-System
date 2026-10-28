import mongoose from 'mongoose';
import { Quiz } from '../models/Quiz.js';
import { Result } from '../models/Result.js';
import { User } from '../models/User.js';
import { Subject } from '../models/Subject.js';
import { Category } from '../models/Category.js';
import { RESULT_STATUS, ROLES } from '../config/constants.js';
import { percentage, round } from '../utils/helpers.js';

const { Types } = mongoose;
const GRADED = [RESULT_STATUS.SUBMITTED, RESULT_STATUS.GRADED];
const toId = (value) => new Types.ObjectId(String(value));

/* ── student ────────────────────────────────────────────────────────────── */

export async function getStudentAnalytics(studentId, { days = 90 } = {}) {
  const id = toId(studentId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [summary] = await Result.aggregate([
    { $match: { student: id, status: { $in: GRADED } } },
    {
      $group: {
        _id: null,
        taken: { $sum: 1 },
        avgScore: { $avg: '$score.percentage' },
        bestScore: { $max: '$score.percentage' },
        worstScore: { $min: '$score.percentage' },
        totalPoints: { $sum: '$score.totalScore' },
        totalTime: { $sum: '$timeSpent' },
        passed: { $sum: { $cond: ['$isPassed', 1, 0] } },
      },
    },
  ]);

  const [trend, byCategory, byDifficulty, recent] = await Promise.all([
    Result.find({ student: id, status: { $in: GRADED }, completedAt: { $gte: since } })
      .sort({ completedAt: 1 })
      .select('score.percentage completedAt quiz')
      .populate('quiz', 'title')
      .lean({ virtuals: false }),
    Result.aggregate([
      { $match: { student: id, status: { $in: GRADED } } },
      { $lookup: { from: 'quizzes', localField: 'quiz', foreignField: '_id', as: 'quizDoc' } },
      { $unwind: '$quizDoc' },
      { $lookup: { from: 'categories', localField: 'quizDoc.category', foreignField: '_id', as: 'cat' } },
      { $unwind: { path: '$cat', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ['$cat.name', 'Uncategorised'] },
          color: { $first: { $ifNull: ['$cat.color', '#6366f1'] } },
          attempts: { $sum: 1 },
          avgScore: { $avg: '$score.percentage' },
        },
      },
      { $sort: { attempts: -1 } },
      { $limit: 8 },
    ]),
    Result.aggregate([
      { $match: { student: id, status: { $in: GRADED } } },
      { $lookup: { from: 'quizzes', localField: 'quiz', foreignField: '_id', as: 'quizDoc' } },
      { $unwind: '$quizDoc' },
      {
        $group: {
          _id: '$quizDoc.difficulty',
          attempts: { $sum: 1 },
          avgScore: { $avg: '$score.percentage' },
        },
      },
    ]),
    Result.find({ student: id })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('quiz', 'title category difficulty')
      .lean({ virtuals: false }),
  ]);

  const totalTime = summary?.totalTime || 0;
  const taken = summary?.taken || 0;

  return {
    summary: {
      quizzesTaken: taken,
      averageScore: round(summary?.avgScore || 0),
      bestScore: round(summary?.bestScore || 0),
      worstScore: round(summary?.worstScore || 0),
      totalPoints: Math.round(summary?.totalPoints || 0),
      passRate: percentage(summary?.passed || 0, taken),
      averageTimePerQuiz: taken ? Math.round(totalTime / taken) : 0,
      totalTimeSpent: totalTime,
    },
    trend: trend.map((r) => ({
      date: r.completedAt,
      quiz: r.quiz?.title || 'Quiz',
      percentage: round(r.score?.percentage || 0),
    })),
    byCategory: byCategory.map((c) => ({
      category: c._id,
      color: c.color,
      attempts: c.attempts,
      averageScore: round(c.avgScore || 0),
    })),
    byDifficulty: byDifficulty.map((d) => ({
      difficulty: d._id || 'medium',
      attempts: d.attempts,
      averageScore: round(d.avgScore || 0),
    })),
    recentAttempts: recent,
  };
}

/* ── teacher ────────────────────────────────────────────────────────────── */

export async function getTeacherAnalytics(teacherId, { days = 30 } = {}) {
  const id = toId(teacherId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const quizIds = await Quiz.find({ teacher: id }).distinct('_id');
  const match = { quiz: { $in: quizIds } };

  const [overview, perQuiz, engagement, hardestQuestions, recentSubmissions] = await Promise.all([
    Result.aggregate([
      { $match: { ...match, status: { $in: GRADED } } },
      {
        $group: {
          _id: null,
          attempts: { $sum: 1 },
          students: { $addToSet: '$student' },
          avgScore: { $avg: '$score.percentage' },
          passed: { $sum: { $cond: ['$isPassed', 1, 0] } },
          avgTime: { $avg: '$timeSpent' },
        },
      },
    ]),
    Result.aggregate([
      { $match: { ...match, status: { $in: GRADED } } },
      {
        $group: {
          _id: '$quiz',
          attempts: { $sum: 1 },
          avgScore: { $avg: '$score.percentage' },
          passRate: { $avg: { $cond: ['$isPassed', 1, 0] } },
        },
      },
      { $lookup: { from: 'quizzes', localField: '_id', foreignField: '_id', as: 'quiz' } },
      { $unwind: '$quiz' },
      {
        $project: {
          title: '$quiz.title',
          difficulty: '$quiz.difficulty',
          isPublished: '$quiz.isPublished',
          questionCount: { $size: '$quiz.questions' },
          attempts: 1,
          avgScore: { $round: ['$avgScore', 1] },
          passRate: { $round: [{ $multiply: ['$passRate', 100] }, 1] },
        },
      },
      { $sort: { attempts: -1 } },
      { $limit: 12 },
    ]),
    Result.aggregate([
      { $match: { ...match, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          attempts: { $sum: 1 },
          avgScore: { $avg: '$score.percentage' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Result.aggregate([
      { $match: { ...match, status: { $in: GRADED } } },
      { $unwind: '$answers' },
      {
        $group: {
          _id: { quiz: '$quiz', question: '$answers.question' },
          text: { $first: '$answers.questionText' },
          type: { $first: '$answers.type' },
          attempts: { $sum: 1 },
          correct: { $sum: { $cond: ['$answers.isCorrect', 1, 0] } },
        },
      },
      { $match: { attempts: { $gte: 3 } } },
      { $project: { text: 1, type: 1, attempts: 1, correctRate: { $round: [{ $multiply: [{ $divide: ['$correct', '$attempts'] }, 100] }, 1] } } },
      { $sort: { correctRate: 1 } },
      { $limit: 8 },
    ]),
    Result.find({ ...match, status: { $in: GRADED } })
      .sort({ completedAt: -1 })
      .limit(8)
      .populate('student', 'username profile.firstName profile.lastName')
      .populate('quiz', 'title')
      .lean({ virtuals: false }),
  ]);

  const quizzes = await Quiz.countDocuments({ teacher: id });
  const published = await Quiz.countDocuments({ teacher: id, isPublished: true });
  const o = overview[0];

  return {
    summary: {
      quizzes,
      published,
      drafts: quizzes - published,
      attempts: o?.attempts || 0,
      uniqueStudents: o?.students?.length || 0,
      averageScore: round(o?.avgScore || 0),
      passRate: percentage(o?.passed || 0, o?.attempts || 0),
      averageTimeSpent: Math.round(o?.avgTime || 0),
    },
    perQuiz,
    engagement,
    hardestQuestions,
    recentSubmissions,
  };
}

/* ── admin ──────────────────────────────────────────────────────────────── */

export async function getSystemAnalytics({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const now = new Date();

  const [
    usersByRole,
    newUsers,
    quizStats,
    resultStats,
    topCategories,
    topQuizzes,
    subjectStats,
    enrollmentStats,
    enrollmentGrowth,
    topSubjects,
  ] = await Promise.all([
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    User.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    Quiz.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          published: { $sum: { $cond: ['$isPublished', 1, 0] } },
          featured: { $sum: { $cond: ['$isFeatured', 1, 0] } },
          attempts: { $sum: '$analytics.totalAttempts' },
          avgScore: { $avg: '$analytics.averageScore' },
        },
      },
    ]),
    Result.aggregate([
      { $match: { status: { $in: GRADED } } },
      {
        $group: {
          _id: null,
          completed: { $sum: 1 },
          avgScore: { $avg: '$score.percentage' },
          passed: { $sum: { $cond: ['$isPassed', 1, 0] } },
          avgTime: { $avg: '$timeSpent' },
        },
      },
    ]),
    Quiz.aggregate([
      { $match: { isPublished: true } },
      { $group: { _id: '$category', quizzes: { $sum: 1 }, attempts: { $sum: '$analytics.totalAttempts' } } },
      { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
      { $unwind: { path: '$category', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: { $ifNull: ['$category.name', 'Uncategorised'] },
          color: { $ifNull: ['$category.color', '#6366f1'] },
          quizzes: 1,
          attempts: 1,
        },
      },
      { $sort: { attempts: -1 } },
      { $limit: 8 },
    ]),
    Quiz.find({ isPublished: true })
      .sort({ 'analytics.totalAttempts': -1 })
      .limit(5)
      .select('title analytics difficulty')
      .lean({ virtuals: false }),
    Subject.aggregate([
      { $match: { isArchived: { $ne: true } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          sections: { $addToSet: '$section' },
          rosterEntries: { $sum: { $size: { $ifNull: ['$students', []] } } },
          activeQrCodes: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$enrollmentCode.token', null] },
                    { $gt: ['$enrollmentCode.expiresAt', now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          qrIssuedInRange: {
            $sum: { $cond: [{ $gte: ['$enrollmentCode.createdAt', since] }, 1, 0] },
          },
        },
      },
    ]),
    Subject.aggregate([
      { $match: { isArchived: { $ne: true } } },
      { $unwind: '$students' },
      {
        $group: {
          _id: null,
          active: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$students.blocked', true] },
                    { $eq: ['$students.status', 'active'] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          pending: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$students.blocked', true] },
                    { $eq: ['$students.status', 'pending'] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          blocked: { $sum: { $cond: ['$students.blocked', 1, 0] } },
          students: { $addToSet: '$students.student' },
        },
      },
    ]),
    Subject.aggregate([
      { $match: { isArchived: { $ne: true } } },
      { $unwind: '$students' },
      { $match: { 'students.enrolledAt': { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$students.enrolledAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Subject.aggregate([
      { $match: { isArchived: { $ne: true } } },
      { $lookup: { from: 'users', localField: 'teacher', foreignField: '_id', as: 'teacherDoc' } },
      { $unwind: { path: '$teacherDoc', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          subjectCode: 1,
          subjectName: 1,
          section: 1,
          program: 1,
          color: 1,
          teacherName: {
            $cond: [
              {
                $gt: [
                  {
                    $strLenCP: {
                      $trim: {
                        input: {
                          $concat: [
                            { $ifNull: ['$teacherDoc.profile.firstName', ''] },
                            ' ',
                            { $ifNull: ['$teacherDoc.profile.lastName', ''] },
                          ],
                        },
                      },
                    },
                  },
                  0,
                ],
              },
              {
                $trim: {
                  input: {
                    $concat: [
                      { $ifNull: ['$teacherDoc.profile.firstName', ''] },
                      ' ',
                      { $ifNull: ['$teacherDoc.profile.lastName', ''] },
                    ],
                  },
                },
              },
              { $ifNull: ['$teacherDoc.username', 'Unassigned'] },
            ],
          },
          enrolledCount: { $size: { $ifNull: ['$students', []] } },
          blockedCount: {
            $size: {
              $filter: {
                input: { $ifNull: ['$students', []] },
                as: 'student',
                cond: '$$student.blocked',
              },
            },
          },
          qrActive: {
            $and: [
              { $ne: ['$enrollmentCode.token', null] },
              { $gt: ['$enrollmentCode.expiresAt', now] },
            ],
          },
        },
      },
      { $sort: { enrolledCount: -1, subjectCode: 1 } },
      { $limit: 6 },
    ]),
  ]);

  const r = resultStats[0] || {};
  const q = quizStats[0] || {};
  const s = subjectStats[0] || {};
  const e = enrollmentStats[0] || {};
  const totalUsers = usersByRole.reduce((sum, u) => sum + u.count, 0);

  const roleMap = Object.fromEntries(usersByRole.map((u) => [u._id, u.count]));

  return {
    users: {
      total: totalUsers,
      students: roleMap[ROLES.STUDENT] || 0,
      teachers: roleMap[ROLES.TEACHER] || 0,
      admins: roleMap[ROLES.ADMIN] || 0,
      newInRange: newUsers.reduce((sum, d) => sum + d.count, 0),
      growth: newUsers,
    },
    quizzes: {
      total: q.total || 0,
      published: q.published || 0,
      featured: q.featured || 0,
      attempts: q.attempts || 0,
      averageScore: round(q.avgScore || 0),
    },
    results: {
      completed: r.completed || 0,
      averageScore: round(r.avgScore || 0),
      passRate: percentage(r.passed || 0, r.completed || 0),
      averageTimeSpent: Math.round(r.avgTime || 0),
    },
    subjects: {
      total: s.total || 0,
      sections: s.sections?.length || 0,
      activeQrCodes: s.activeQrCodes || 0,
      qrIssuedInRange: s.qrIssuedInRange || 0,
      rosterEntries: s.rosterEntries || 0,
      activeEnrollments: e.active || 0,
      pendingEnrollments: e.pending || 0,
      blockedEnrollments: e.blocked || 0,
      uniqueStudents: e.students?.length || 0,
      newEnrollments: enrollmentGrowth.reduce((sum, d) => sum + d.count, 0),
      growth: enrollmentGrowth,
      topSubjects,
    },
    categories: topCategories,
    topQuizzes,
  };
}

/**
 * Every subject with its enrollment and QR state, for exports.
 * Plain reads rather than an aggregation: a department has tens of subjects,
 * and the roster/QR arithmetic stays readable here.
 */
export async function getSubjectRows({ now = new Date() } = {}) {
  const docs = await Subject.find({ isArchived: { $ne: true } })
    .sort({ subjectCode: 1, section: 1 })
    .populate('teacher', 'username profile.firstName profile.lastName')
    .lean({ virtuals: false });

  const displayName = (teacher) => {
    if (!teacher) return 'Unassigned';
    const name = `${teacher.profile?.firstName || ''} ${teacher.profile?.lastName || ''}`.trim();
    return name || teacher.username || 'Unassigned';
  };

  return docs.map((s) => {
    const roster = s.students || [];
    const expiresAt = s.enrollmentCode?.expiresAt || null;

    return {
      subjectCode: s.subjectCode,
      subjectName: s.subjectName,
      section: s.section,
      program: s.program || '',
      teacher: displayName(s.teacher),
      enrolledCount: roster.length,
      activeCount: roster.filter((r) => !r.blocked && r.status === 'active').length,
      pendingCount: roster.filter((r) => !r.blocked && r.status === 'pending').length,
      blockedCount: roster.filter((r) => r.blocked).length,
      qrActive: Boolean(s.enrollmentCode?.token && expiresAt && expiresAt > now),
      qrExpiresAt: expiresAt,
    };
  });
}

/* ── exports / reports ──────────────────────────────────────────────────── */

export async function buildReport({ from, to, type = 'overview', days = 30 } = {}) {
  const range = {};
  if (from || to) {
    range.createdAt = {};
    if (from) range.createdAt.$gte = new Date(from);
    if (to) range.createdAt.$lte = new Date(to);
  }

  if (type === 'users') {
    const rows = await User.find(range).select('username email role stats.averageScore security.isActive createdAt').lean();
    return { type, generatedAt: new Date(), count: rows.length, rows };
  }

  if (type === 'quizzes') {
    const rows = await Quiz.find(range)
      .populate('teacher', 'username')
      .populate('category', 'name')
      .select('title teacher category difficulty isPublished analytics createdAt')
      .lean();
    return { type, generatedAt: new Date(), count: rows.length, rows };
  }

  if (type === 'subjects') {
    const [analytics, rows] = await Promise.all([getSystemAnalytics({ days }), getSubjectRows()]);
    return {
      type,
      generatedAt: new Date(),
      range: { from: from || null, to: to || null },
      days,
      summary: analytics.subjects,
      rows,
    };
  }

  if (type === 'results') {
    const rows = await Result.find(range)
      .populate('student', 'username')
      .populate('quiz', 'title')
      .select('student quiz score isPassed timeSpent completedAt')
      .limit(5000)
      .lean();
    return { type, generatedAt: new Date(), count: rows.length, rows };
  }

  const [users, quizzes, results, categories] = await Promise.all([
    User.countDocuments(range),
    Quiz.countDocuments(range),
    Result.countDocuments(range),
    Category.countDocuments(),
  ]);

  return {
    type: 'overview',
    generatedAt: new Date(),
    range: { from: from || null, to: to || null },
    totals: { users, quizzes, results, categories },
  };
}

export default { getStudentAnalytics, getTeacherAnalytics, getSystemAnalytics, getSubjectRows, buildReport };
