import { Quiz } from '../models/Quiz.js';
import { Result } from '../models/Result.js';
import { User } from '../models/User.js';
import { ATTEMPT_KEY_PREFIX, QUIZ_SESSION_PREFIX, RESULT_STATUS, ROLES } from '../config/constants.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { percentage, round, seededShuffle, shuffle, serialize } from '../utils/helpers.js';
import cache from '../utils/cache.js';
import logger from '../utils/logger.js';
import { assertSubjectAccess } from './subjectService.js';

/* ── answer normalisation & grading ─────────────────────────────────────── */

const normalizeText = (value = '') =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:]+$/g, '');

const asIndex = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
};

/**
 * Pure grading function — the single source of truth for correctness.
 * Returns { isCorrect, needsManualGrading }.
 */
export function gradeAnswer(question, studentAnswer) {
  const { type, correctAnswer } = question;

  if (type === 'essay') {
    return { isCorrect: null, needsManualGrading: true };
  }

  if (studentAnswer === null || studentAnswer === undefined || studentAnswer === '') {
    return { isCorrect: false, needsManualGrading: false };
  }

  if (type === 'multiple_choice') {
    const expected = Array.isArray(correctAnswer) ? correctAnswer.map(asIndex) : [asIndex(correctAnswer)];
    const given = Array.isArray(studentAnswer) ? studentAnswer.map(asIndex) : [asIndex(studentAnswer)];
    if (expected.some((e) => e === null) || given.some((g) => g === null)) {
      // Allow text answers as a fallback (e.g. option text submitted directly).
      const known = (question.options || []).map((o) => normalizeText(o.text));
      const givenText = normalizeText(Array.isArray(studentAnswer) ? studentAnswer[0] : studentAnswer);
      const expectedText = Array.isArray(correctAnswer)
        ? correctAnswer.map((i) => known[asIndex(i)]).filter(Boolean)
        : [known[asIndex(correctAnswer)]].filter(Boolean);
      return { isCorrect: expectedText.includes(givenText), needsManualGrading: false };
    }
    if (expected.length !== given.length) return { isCorrect: false, needsManualGrading: false };
    return {
      isCorrect: expected.sort().every((value, i) => value === given.sort()[i]),
      needsManualGrading: false,
    };
  }

  if (type === 'true_false') {
    const expected = correctAnswer === true || correctAnswer === 'true';
    const given = studentAnswer === true || studentAnswer === 'true';
    return { isCorrect: expected === given, needsManualGrading: false };
  }

  if (type === 'short_answer') {
    const accepted = (Array.isArray(correctAnswer) ? correctAnswer : [correctAnswer])
      .filter((a) => a !== null && a !== undefined)
      .map((a) => normalizeText(a));
    const given = normalizeText(Array.isArray(studentAnswer) ? studentAnswer[0] : studentAnswer);
    return { isCorrect: accepted.includes(given), needsManualGrading: false };
  }

  return { isCorrect: false, needsManualGrading: false };
}

/* ── quiz presentation ──────────────────────────────────────────────────── */

/** Student-facing quiz payload: no answer keys, no explanations before submit. */
export function buildStudentView(quiz, { seed = '', shuffleQuestions = null, shuffleOptions = null } = {}) {
  const quizDoc = quiz.toObject ? quiz.toObject({ virtuals: true }) : quiz;
  const shouldShuffleQuestions = shuffleQuestions ?? quizDoc.settings?.randomizeQuestions;
  const shouldShuffleOptions = shuffleOptions ?? quizDoc.settings?.randomizeOptions;

  let questions = quizDoc.questions || [];
  if (shouldShuffleQuestions) questions = seededShuffle(questions, `${seed}:questions`);

  questions = questions.map((q, index) => {
    const base = {
      id: q._id.toString(),
      type: q.type,
      question: q.question,
      points: q.points,
      timeLimit: q.timeLimit || quizDoc.settings?.timePerQuestion,
      difficulty: q.difficulty,
      imageUrl: q.imageUrl,
      order: index,
    };

    if (q.type === 'multiple_choice') {
      let options = (q.options || []).map((o, i) => ({ index: i, text: o.text }));
      if (shouldShuffleOptions) {
        const ordered = seededShuffle(options, `${seed}:${q._id}:options`);
        // Keep a stable mapping so submitted indexes still resolve correctly.
        return { ...base, options: ordered.map((o) => ({ index: o.index, text: o.text })) };
      }
      return { ...base, options };
    }

    if (q.type === 'true_false') {
      return { ...base, options: [{ index: true, text: 'True' }, { index: false, text: 'False' }] };
    }

    return base;
  });

  questions = questions.map((q, i) => ({ ...q, order: i }));

  return {
    id: quizDoc._id.toString(),
    title: quizDoc.title,
    description: quizDoc.description,
    category: quizDoc.category,
    difficulty: quizDoc.difficulty,
    tags: quizDoc.tags,
    settings: {
      timePerQuestion: quizDoc.settings?.timePerQuestion,
      totalTimeLimit: quizDoc.settings?.totalTimeLimit,
      passingScore: quizDoc.settings?.passingScore,
      allowRetakes: quizDoc.settings?.allowRetakes,
      maxAttempts: quizDoc.settings?.maxAttempts,
      showCorrectAnswers: quizDoc.settings?.showCorrectAnswers,
    },
    questionCount: questions.length,
    totalPoints: questions.reduce((sum, q) => sum + (q.points || 0), 0),
    questions,
  };
}

const attemptKey = (resultId) => `${ATTEMPT_KEY_PREFIX}${resultId}`;

/* ── attempt lifecycle ──────────────────────────────────────────────────── */

/**
 * Catalogue-safe summary: strips the question array entirely (so no answer keys
 * or prompts leak before an attempt starts) and derives the counts the cards
 * and tables need.
 */
export function summariseQuiz(quiz) {
  const doc = quiz?.toObject ? quiz.toObject({ virtuals: true }) : { ...quiz };
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  const settings = doc.settings || {};

  delete doc.questions;
  delete doc.__v;

  const totalSeconds = settings.totalTimeLimit
    ? settings.totalTimeLimit
    : questions.reduce((sum, q) => sum + (q.timeLimit || settings.timePerQuestion || 60), 0);

  return {
    ...doc,
    questionCount: questions.length,
    totalPoints: questions.reduce((sum, q) => sum + (q.points || 0), 0),
    estimatedMinutes: Math.max(1, Math.round(totalSeconds / 60)),
  };
}

export async function getQuizForAttempt(quizId) {
  const quiz = await Quiz.findById(quizId).populate('category', 'name slug color icon');
  if (!quiz) throw new NotFoundError('Quiz');
  if (!quiz.isPublished) throw new ForbiddenError('This quiz is not published yet');
  return quiz;
}

/**
 * Start (or resume) an attempt. The server records the authoritative start time
 * in Redis so a client cannot extend its own timer.
 */
export async function startAttempt({ quizId, studentId, ipAddress = '' }) {
  const quiz = await getQuizForAttempt(quizId);

  // Subject-scoped quizzes are members-only: enrollment, no blocking, approved.
  await assertSubjectAccess(quiz, { _id: studentId, role: ROLES.STUDENT });

  const existing = await Result.findOne({
    quiz: quiz._id,
    student: studentId,
    status: RESULT_STATUS.IN_PROGRESS,
  });

  if (existing) {
    const session = await cache.getJSON(attemptKey(existing._id));
    const view = buildStudentView(quiz, { seed: existing._id.toString() });
    return {
      attempt: existing,
      quiz: view,
      deadline: session?.deadline || null,
      resumed: true,
    };
  }

  const completed = await Result.countDocuments({ quiz: quiz._id, student: studentId });
  const { allowRetakes, maxAttempts } = quiz.settings;

  if (completed > 0 && !allowRetakes) throw new ForbiddenError('Retakes are disabled for this quiz');
  if (completed >= maxAttempts) {
    throw new ForbiddenError(`You have used all ${maxAttempts} attempts for this quiz`);
  }

  const attemptNumber = completed + 1;
  const result = new Result({
    quiz: quiz._id,
    student: studentId,
    teacher: quiz.teacher,
    attemptNumber,
    passingScore: quiz.settings.passingScore,
    status: RESULT_STATUS.IN_PROGRESS,
    startedAt: new Date(),
    ipAddress,
    answers: quiz.questions.map((q) => ({
      question: q._id,
      questionText: q.question,
      type: q.type,
      maxPoints: q.points || 1,
      pointsEarned: 0,
      needsManualGrading: q.type === 'essay',
    })),
  });
  await result.save();

  const totalSeconds = quiz.settings.totalTimeLimit
    ? quiz.settings.totalTimeLimit
    : quiz.questions.reduce(
        (sum, q) => sum + (q.timeLimit || quiz.settings.timePerQuestion || 60),
        0,
      );

  const deadline = new Date(Date.now() + totalSeconds * 1000).toISOString();
  await cache.setJSON(attemptKey(result._id), { quizId: quiz._id.toString(), deadline, totalSeconds }, totalSeconds + 300);

  quiz.analytics.totalAttempts += 1;
  await quiz.save();

  return {
    attempt: result,
    quiz: buildStudentView(quiz, { seed: result._id.toString() }),
    deadline,
    resumed: false,
  };
}

/**
 * Grade a submission. Answers are graded server-side against the stored quiz —
 * the client only ever sends the question id and the answer.
 */
export async function submitAttempt({ quizId, studentId, answers = [], timeSpent = 0, attemptId = null }) {
  const quiz = await Quiz.findById(quizId);
  if (!quiz) throw new NotFoundError('Quiz');

  const query = { quiz: quiz._id, student: studentId, status: RESULT_STATUS.IN_PROGRESS };
  if (attemptId) query._id = attemptId;

  const result = await Result.findOne(query).sort({ createdAt: -1 });
  if (!result) {
    const anyAttempt = await Result.findOne({ quiz: quiz._id, student: studentId, _id: attemptId || { $exists: true } });
    if (anyAttempt) throw new ConflictError('This attempt has already been submitted');
    throw new NotFoundError('Active attempt');
  }

  const session = await cache.getJSON(attemptKey(result._id));
  const answerMap = new Map(answers.map((a) => [String(a.questionId), a.answer]));

  const questionById = new Map(quiz.questions.map((q) => [q._id.toString(), q]));

  result.answers = quiz.questions.map((q) => {
    const questionId = q._id.toString();
    const submitted = answerMap.has(questionId) ? answerMap.get(questionId) : null;
    const { isCorrect, needsManualGrading } = gradeAnswer(q, submitted);
    return {
      question: q._id,
      questionText: q.question,
      type: q.type,
      studentAnswer: submitted ?? null,
      isCorrect,
      needsManualGrading,
      pointsEarned: isCorrect === true ? q.points : 0,
      maxPoints: q.points || 1,
      feedback: '',
    };
  });

  const elapsed = Math.max(0, Math.round((Date.now() - result.startedAt.getTime()) / 1000));
  const serverTime = session?.totalSeconds ? Math.min(elapsed, session.totalSeconds) : elapsed;
  result.timeSpent = timeSpent > 0 ? Math.min(Math.round(timeSpent), serverTime || timeSpent) : serverTime;

  const hasManual = result.answers.some((a) => a.needsManualGrading);
  result.status = hasManual ? RESULT_STATUS.SUBMITTED : RESULT_STATUS.GRADED;
  result.completedAt = new Date();
  result.gradedAt = hasManual ? null : new Date();
  result.recalculate();
  await result.save();

  await cache.del(attemptKey(result._id));

  quiz.analytics.completedAttempts += 1;
  await quiz.save();
  await recomputeQuizAnalytics(quiz._id);
  await recomputeStudentStats(studentId);

  logger.info(`Attempt graded quiz=${quiz._id} student=${studentId} score=${result.score.percentage}%`);

  return { result, quiz, needsManualGrading: hasManual };
}

/** Teacher/admin manual grading for essay answers. */
export async function gradeSubmission({ resultId, grades = [], graderId }) {
  const result = await Result.findById(resultId).populate('quiz', 'title questions settings');
  if (!result) throw new NotFoundError('Result');
  if (result.status === RESULT_STATUS.IN_PROGRESS) {
    throw new ConflictError('This attempt has not been submitted yet');
  }

  const gradeMap = new Map(grades.map((g) => [String(g.questionId), g]));
  let gradedAnything = false;

  result.answers.forEach((answer) => {
    const grade = gradeMap.get(answer.question.toString());
    if (!grade) return;
    const maxPoints = answer.maxPoints || 0;
    const points = Math.min(Math.max(0, grade.pointsEarned), maxPoints || grade.pointsEarned);
    answer.pointsEarned = round(points);
    answer.isCorrect = maxPoints > 0 ? points >= maxPoints : points > 0;
    answer.needsManualGrading = false;
    if (grade.feedback !== undefined) answer.feedback = grade.feedback;
    gradedAnything = true;
  });

  if (!gradedAnything) throw new ValidationError('None of the provided grades matched this attempt');

  const stillPending = result.answers.some((a) => a.needsManualGrading);
  if (!stillPending) {
    result.status = RESULT_STATUS.GRADED;
    result.gradedAt = new Date();
    result.gradedBy = graderId;
  }
  result.recalculate();
  await result.save();

  await recomputeQuizAnalytics(result.quiz._id || result.quiz);
  await recomputeStudentStats(result.student);

  return result;
}

/* ── aggregates ─────────────────────────────────────────────────────────── */

export async function recomputeQuizAnalytics(quizId) {
  const rows = await Result.aggregate([
    { $match: { quiz: quizId, status: { $in: [RESULT_STATUS.SUBMITTED, RESULT_STATUS.GRADED] } } },
    {
      $group: {
        _id: '$quiz',
        attempts: { $sum: 1 },
        avgScore: { $avg: '$score.percentage' },
        avgTime: { $avg: '$timeSpent' },
        passed: { $sum: { $cond: ['$isPassed', 1, 0] } },
      },
    },
  ]);

  const quiz = await Quiz.findById(quizId);
  if (!quiz) return null;

  const row = rows[0];
  quiz.analytics.completedAttempts = row?.attempts || 0;
  quiz.analytics.averageScore = round(row?.avgScore || 0);
  quiz.analytics.averageTimeSpent = Math.round(row?.avgTime || 0);
  quiz.analytics.passRate = percentage(row?.passed || 0, row?.attempts || 0);
  quiz.analytics.completionRate = quiz.analytics.totalAttempts
    ? percentage(row?.attempts || 0, quiz.analytics.totalAttempts)
    : 0;
  await quiz.save();
  return quiz.analytics;
}

export async function recomputeStudentStats(studentId) {
  const user = await User.findById(studentId);
  if (!user) return null;

  const gradedOnly = { student: studentId, status: { $in: [RESULT_STATUS.SUBMITTED, RESULT_STATUS.GRADED] } };
  const [agg] = await Result.aggregate([
    { $match: gradedOnly },
    {
      $group: {
        _id: '$student',
        taken: { $sum: 1 },
        avgScore: { $avg: '$score.percentage' },
        points: { $sum: '$score.totalScore' },
      },
    },
  ]);

  const recentDays = await Result.aggregate([
    { $match: { ...gradedOnly, completedAt: { $ne: null } } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt' } } } },
    { $sort: { _id: -1 } },
    { $limit: 400 },
  ]);

  const days = new Set(recentDays.map((d) => d._id));
  let streak = 0;
  const cursor = new Date();
  // Allow the streak to start today or yesterday.
  const todayKey = cursor.toISOString().slice(0, 10);
  if (!days.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  user.stats.quizzesTaken = agg?.taken || 0;
  user.stats.averageScore = round(agg?.avgScore || 0);
  user.stats.totalPoints = Math.round(agg?.points || 0);
  user.stats.currentStreak = streak;
  user.stats.longestStreak = Math.max(user.stats.longestStreak || 0, streak);
  user.stats.lastActivityAt = new Date();
  await user.save();

  return user.stats;
}

/** Detailed review payload; hides answer keys unless allowed. */
export function buildResultReview(result, quiz, { includeAnswers = true } = {}) {
  const quizDoc = quiz?.toObject ? quiz.toObject() : quiz;
  const questionMap = new Map((quizDoc?.questions || []).map((q) => [q._id.toString(), q]));

  return {
    ...serialize(result),
    quiz: quizDoc
      ? { id: quizDoc._id.toString(), title: quizDoc.title, category: quizDoc.category, teacher: quizDoc.teacher }
      : result.quiz,
    answers: result.answers.map((answer) => {
      const question = questionMap.get(answer.question.toString());
      const base = serialize(answer);
      if (!includeAnswers || !question) return base;
      return {
        ...base,
        correctAnswer: question.correctAnswer,
        explanation: question.explanation,
        // Include positional indexes so the client can render option text for
        // stored numeric answers.
        options: (question.options || []).map((option, index) => ({ index, text: option.text })),
      };
    }),
  };
}

export async function findQuizOrThrow(quizId) {
  const quiz = await Quiz.findById(quizId).populate('category', 'name slug color icon').populate('teacher', 'username profile');
  if (!quiz) throw new NotFoundError('Quiz');
  return quiz;
}

export default {
  gradeAnswer,
  buildStudentView,
  startAttempt,
  submitAttempt,
  gradeSubmission,
  recomputeQuizAnalytics,
  recomputeStudentStats,
  buildResultReview,
  findQuizOrThrow,
  summariseQuiz,
  shuffle,
};
