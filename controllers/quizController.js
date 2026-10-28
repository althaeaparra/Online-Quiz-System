import { Quiz } from '../models/Quiz.js';
import { Category } from '../models/Category.js';
import { Subject } from '../models/Subject.js';
import { Result } from '../models/Result.js';
import { User } from '../models/User.js';
import { ROLES, RESULT_STATUS, QUIZ_DEFAULTS } from '../config/constants.js';
import { asyncHandler, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/errors.js';
import { getPagination, paginationMeta, serialize } from '../utils/helpers.js';
import { ok, created, noContent } from '../utils/response.js';
import { buildStudentView, buildResultReview, gradeSubmission, summariseQuiz } from '../services/quizService.js';
import { notifyQuizPublished } from '../services/notificationService.js';
import { assertSubjectAccess } from '../services/subjectService.js';

/**
 * Quiz catalogue + authoring endpoints shared by teachers, admins and the
 * public API. Student-specific attempt flow lives in studentController.
 */

/* ── authoring (teacher / admin) ────────────────────────────────────────── */

/** POST /api/teacher/quizzes */
export const createQuiz = asyncHandler(async (req, res) => {
  const category = await Category.findById(req.body.category);
  if (!category || !category.isActive) throw new NotFoundError('Category');

  const { isPublished = false, ...rest } = req.body;

  if (rest.subject) {
    const owned = await Subject.findOne({ _id: rest.subject, isArchived: false });
    if (!owned) throw new NotFoundError('Subject');
    if (req.user.role !== ROLES.ADMIN && owned.teacher.toString() !== req.user._id.toString()) {
      throw new ForbiddenError('You can only attach quizzes to your own subjects');
    }
  }

  const quiz = new Quiz({
    ...rest,
    teacher: req.user._id,
    isPublished,
    settings: { ...QUIZ_DEFAULTS, ...(rest.settings || {}) },
  });

  await quiz.save();

  await Category.updateOne({ _id: category._id }, { $inc: { quizCount: 1 } });
  await User.updateOne({ _id: req.user._id }, { $inc: { 'stats.quizzesCreated': 1 } });

  if (quiz.isPublished) {
    await notifyQuizPublished({ quiz, teacher: req.user });
  }

  return created(res, serialize(quiz));
});

/** PATCH /api/teacher/quizzes/:id */
export const updateQuiz = asyncHandler(async (req, res) => {
  const quiz = req.resource || (await Quiz.findById(req.params.id));
  if (!quiz) throw new NotFoundError('Quiz');

  const wasPublished = quiz.isPublished;
  const { questions, settings, category, subject: subjectId, ...rest } = req.body;

  if (subjectId) {
    const owned = await Subject.findOne({ _id: subjectId, isArchived: false });
    if (!owned) throw new NotFoundError('Subject');
    if (req.user.role !== ROLES.ADMIN && owned.teacher.toString() !== req.user._id.toString()) {
      throw new ForbiddenError('You can only attach quizzes to your own subjects');
    }
  }
  if (subjectId !== undefined) quiz.subject = subjectId || null;

  if (category) {
    const exists = await Category.findById(category);
    if (!exists) throw new NotFoundError('Category');
    if (!quiz.category.equals(category)) {
      await Category.updateOne({ _id: quiz.category }, { $inc: { quizCount: -1 } });
      await Category.updateOne({ _id: category }, { $inc: { quizCount: 1 } });
    }
    quiz.category = category;
  }

  if (Array.isArray(questions)) quiz.questions = questions;
  if (settings) quiz.settings = { ...quiz.settings.toObject(), ...settings };
  Object.assign(quiz, rest);

  await quiz.save();

  if (!wasPublished && quiz.isPublished) {
    await notifyQuizPublished({ quiz, teacher: req.user });
  }

  return ok(res, serialize(quiz));
});

/** DELETE /api/teacher/quizzes/:id */
export const deleteQuiz = asyncHandler(async (req, res) => {
  const quiz = req.resource || (await Quiz.findById(req.params.id));
  if (!quiz) throw new NotFoundError('Quiz');

  const attemptCount = await Result.countDocuments({ quiz: quiz._id });
  if (attemptCount > 0) {
    // Preserve history: archive instead of hard-deleting.
    quiz.isPublished = false;
    quiz.isArchived = true;
    await quiz.save();
    await Category.updateOne({ _id: quiz.category }, { $inc: { quizCount: -1 } });
    return ok(res, { archived: true, message: 'Quiz has attempts and was archived instead of deleted' });
  }

  await quiz.deleteOne();
  await Category.updateOne({ _id: quiz.category }, { $inc: { quizCount: -1 } });
  return noContent(res);
});

/** POST /api/teacher/quizzes/:id/publish */
export const publishQuiz = asyncHandler(async (req, res) => {
  const quiz = req.resource || (await Quiz.findById(req.params.id));
  if (!quiz) throw new NotFoundError('Quiz');
  if (!quiz.questions.length) throw new ConflictError('Add at least one question before publishing');

  const publish = req.body?.isPublished !== false;
  if (quiz.isPublished === publish) {
    return ok(res, serialize(quiz), { message: `Quiz is already ${publish ? 'published' : 'unpublished'}` });
  }

  quiz.isPublished = publish;
  await quiz.save();

  if (publish) await notifyQuizPublished({ quiz, teacher: req.user });

  return ok(res, serialize(quiz), { message: publish ? 'Quiz published' : 'Quiz unpublished' });
});

/** POST /api/teacher/quizzes/:id/duplicate */
export const duplicateQuiz = asyncHandler(async (req, res) => {
  const source = await Quiz.findById(req.params.id).lean({ virtuals: false });
  if (!source) throw new NotFoundError('Quiz');

  const { _id, createdAt, updatedAt, slug, analytics, __v, ...rest } = source;
  const copy = await Quiz.create({
    ...rest,
    title: `${source.title} (copy)`,
    teacher: req.user._id,
    isPublished: false,
    publishedAt: null,
    analytics: {},
  });

  return created(res, serialize(copy));
});

/* ── catalogue ─────────────────────────────────────────────────────────── */

/** GET /api/quizzes (public catalogue) + /api/teacher/quizzes (own list) */
export const listQuizzes = asyncHandler(async (req, res) => {
  const query = req.validatedQuery || req.query;
  const { page, limit, skip } = getPagination(query);
  const filter = {};

  const isTeacherScope = req.baseUrl.includes('/teacher');
  if (isTeacherScope) {
    filter.teacher = req.user._id;
  } else if (req.user?.role === ROLES.ADMIN && query.all === 'true') {
    // admins may list drafts too
  } else {
    filter.isPublished = true;
  }

  if (query.search) {
    filter.$text = { $search: query.search };
  }
  if (query.category) filter.category = query.category;
  if (query.difficulty) filter.difficulty = query.difficulty;
  if (query.featured === 'true') filter.isFeatured = true;

  const sortMap = {
    newest: { createdAt: -1 },
    popular: { 'analytics.totalAttempts': -1 },
    rating: { 'analytics.rating': -1 },
    title: { title: 1 },
  };

  const [items, total] = await Promise.all([
    Quiz.find(filter)
      .sort(sortMap[query.sort] || sortMap.newest)
      .skip(skip)
      .limit(limit)
      .populate('category', 'name slug color icon')
      .populate('teacher', 'username profile.firstName profile.lastName')
      .populate('subject', 'subjectCode subjectName section')
      // Only the fields needed to summarise a card — never prompts or keys.
      .select('title description difficulty tags thumbnail settings analytics isPublished isFeatured isArchived createdAt updatedAt category teacher subject questions._id questions.points questions.timeLimit')
      .lean({ virtuals: true }),
    Quiz.countDocuments(filter),
  ]);

  return ok(res, items.map(summariseQuiz), { meta: paginationMeta({ page, limit, total }) });
});

/** GET /api/quizzes/:id — public preview (never leaks answer keys) */
export const getQuiz = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findById(req.params.id)
    .populate('category', 'name slug color icon')
    .populate('teacher', 'username profile.firstName profile.lastName');

  if (!quiz) throw new NotFoundError('Quiz');

  const isOwner = req.user && quiz.teacher?._id?.toString() === req.user._id.toString();
  const isAdmin = req.user?.role === ROLES.ADMIN;

  if (!quiz.isPublished && !isOwner && !isAdmin) throw new NotFoundError('Quiz');

  if (isOwner || isAdmin) return ok(res, serialize(quiz));

  // Section-gated quizzes require an enrolled student, even for the preview.
  if (quiz.subject) {
    if (!req.user) throw new UnauthorizedError('Sign in with your student account to view this quiz');
    await assertSubjectAccess(quiz, req.user);
  }

  const preview = buildStudentView(quiz, { seed: quiz._id.toString(), shuffleQuestions: false, shuffleOptions: false });
  return ok(res, {
    ...preview,
    teacher: quiz.teacher,
    isPublished: quiz.isPublished,
    analytics: { totalAttempts: quiz.analytics.totalAttempts, averageScore: quiz.analytics.averageScore },
  });
});

/** GET /api/quizzes/:id/questions — student-safe question set */
export const getQuizQuestions = asyncHandler(async (req, res) => {
  const quiz = await Quiz.findById(req.params.id);
  if (!quiz) throw new NotFoundError('Quiz');
  if (!quiz.isPublished) throw new ForbiddenError('This quiz is not published');

  if (quiz.subject) {
    if (!req.user) throw new UnauthorizedError('Sign in with your student account to view this quiz');
    await assertSubjectAccess(quiz, req.user);
  }

  return ok(res, buildStudentView(quiz, { seed: quiz._id.toString() }));
});

/* ── shared result views ───────────────────────────────────────────────── */

/** GET /api/results/:id — student (own), owning teacher, or admin. */
export const getResult = asyncHandler(async (req, res) => {
  const result = await Result.findById(req.params.id).populate('student', 'username profile').populate('quiz', 'title teacher category');
  if (!result) throw new NotFoundError('Result');

  const isStudent = result.student?._id?.toString() === req.user._id.toString();
  const isTeacher = result.quiz?.teacher?.toString() === req.user._id.toString();
  const isAdmin = req.user.role === ROLES.ADMIN;

  if (!isStudent && !isTeacher && !isAdmin) throw new ForbiddenError('You cannot view this result');
  if (result.status === RESULT_STATUS.IN_PROGRESS) throw new ConflictError('This attempt has not been submitted yet');

  const quiz = await Quiz.findById(result.quiz?._id || result.quiz);
  const includeAnswers =
    isStudent
      ? Boolean(quiz?.settings?.showCorrectAnswers) || result.status === RESULT_STATUS.GRADED
      : true;

  return ok(res, {
    ...buildResultReview(result, quiz, { includeAnswers }),
    student: isStudent ? undefined : result.student,
  });
});

/** POST /api/teacher/results/:id/grade — manual essay grading. */
export const gradeResult = asyncHandler(async (req, res) => {
  const result = await Result.findById(req.params.id).populate('quiz', 'teacher title');
  if (!result) throw new NotFoundError('Result');
  if (req.user.role !== ROLES.ADMIN && result.quiz?.teacher?.toString() !== req.user._id.toString()) {
    throw new ForbiddenError('Only the quiz owner can grade this attempt');
  }

  const graded = await gradeSubmission({
    resultId: req.params.id,
    grades: req.body.grades,
    graderId: req.user._id,
  });

  return ok(res, serialize(graded), { message: 'Grades saved' });
});

export default {
  createQuiz,
  updateQuiz,
  deleteQuiz,
  publishQuiz,
  duplicateQuiz,
  listQuizzes,
  getQuiz,
  getQuizQuestions,
  getResult,
  gradeResult,
};
