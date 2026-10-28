/**
 * Seed the database with a demo cohort.
 *
 *   npm run seed            # wipe demo collections, then seed
 *   npm run seed -- --keep  # seed without wiping existing data
 *
 * All demo accounts use the password: Password123
 */
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { connectDB, disconnectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { Category } from '../models/Category.js';
import { Quiz } from '../models/Quiz.js';
import { Subject } from '../models/Subject.js';
import { Result } from '../models/Result.js';
import { Notification } from '../models/Notification.js';
import { ROLES } from '../config/constants.js';
import { recomputeQuizAnalytics, recomputeStudentStats } from '../services/quizService.js';
import logger from '../utils/logger.js';

const DEMO_PASSWORD = 'Password123';

const CATEGORIES = [
  { name: 'Mathematics', icon: 'sigma', color: '#6366f1', description: 'Algebra, geometry and beyond', order: 1 },
  { name: 'Science', icon: 'atom', color: '#22d3ee', description: 'Physics, chemistry and biology', order: 2 },
  { name: 'History', icon: 'landmark', color: '#f59e0b', description: 'People, places and turning points', order: 3 },
  { name: 'Programming', icon: 'code', color: '#a855f7', description: 'Computer science fundamentals', order: 4 },
  { name: 'Languages', icon: 'languages', color: '#34d399', description: 'Vocabulary and grammar', order: 5 },
];

const QUIZZES = [
  {
    title: 'Algebra Foundations',
    category: 'Mathematics',
    difficulty: 'easy',
    description: 'Linear equations, factoring and the order of operations.',
    isFeatured: true,
    settings: { timePerQuestion: 45, passingScore: 60, maxAttempts: 3 },
    questions: [
      { type: 'multiple_choice', question: 'Solve for x: 2x + 6 = 18', options: ['x = 4', 'x = 6', 'x = 8', 'x = 12'], correctAnswer: 1, points: 10, explanation: 'Subtract 6 from both sides, then divide by 2.' },
      { type: 'true_false', question: 'The expression 3(x + 4) expands to 3x + 12.', correctAnswer: true, points: 5 },
      { type: 'short_answer', question: 'What is the slope of the line y = 5x - 3?', correctAnswer: ['5', 'five'], points: 10 },
      { type: 'multiple_choice', question: 'Factor x² - 9', options: ['(x - 3)(x + 3)', '(x - 9)(x + 1)', '(x - 3)²', 'Cannot be factored'], correctAnswer: 0, points: 10, explanation: 'This is a difference of squares.' },
    ],
  },
  {
    title: 'Solar System Basics',
    category: 'Science',
    difficulty: 'easy',
    description: 'Planets, orbits and what makes our neighbourhood tick.',
    isFeatured: true,
    settings: { timePerQuestion: 30, passingScore: 60, randomizeQuestions: true },
    questions: [
      { type: 'multiple_choice', question: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correctAnswer: 1, points: 10 },
      { type: 'true_false', question: 'Jupiter is the largest planet in the Solar System.', correctAnswer: true, points: 5 },
      { type: 'multiple_choice', question: 'How many moons does Earth have?', options: ['0', '1', '2', '4'], correctAnswer: 1, points: 5 },
      { type: 'short_answer', question: 'Which planet is closest to the Sun?', correctAnswer: ['mercury'], points: 10 },
      { type: 'essay', question: 'Explain in a few sentences why seasons happen.', points: 20, explanation: 'Graded by the teacher — look for axial tilt.' },
    ],
  },
  {
    title: 'JavaScript Essentials',
    category: 'Programming',
    difficulty: 'medium',
    description: 'Closures, event loops and the bits that trip people up.',
    settings: { timePerQuestion: 60, passingScore: 70, maxAttempts: 2, randomizeQuestions: true, randomizeOptions: true },
    questions: [
      { type: 'multiple_choice', question: 'Which keyword creates a block-scoped binding?', options: ['var', 'let', 'function', 'with'], correctAnswer: 1, points: 10 },
      { type: 'true_false', question: '`typeof null` returns "object".', correctAnswer: true, points: 5, explanation: 'A long-standing quirk of the language.' },
      { type: 'short_answer', question: 'What does JSON stand for? (One word is fine: name the first word)', correctAnswer: ['javascript'], points: 10 },
      { type: 'essay', question: 'Describe what the event loop does when a promise resolves.', points: 20 },
    ],
  },
  {
    title: 'World War II Timeline',
    category: 'History',
    difficulty: 'hard',
    description: 'Key dates and turning points between 1939 and 1945.',
    settings: { timePerQuestion: 40, passingScore: 65 },
    questions: [
      { type: 'multiple_choice', question: 'In which year did World War II begin?', options: ['1914', '1937', '1939', '1941'], correctAnswer: 2, points: 10 },
      { type: 'true_false', question: 'D-Day took place in June 1944.', correctAnswer: true, points: 5 },
      { type: 'multiple_choice', question: 'Which battle is considered the turning point on the Eastern Front?', options: ['Stalingrad', 'Dunkirk', 'Midway', 'El Alamein'], correctAnswer: 0, points: 15 },
      { type: 'short_answer', question: 'Name the German air force.', correctAnswer: ['luftwaffe'], points: 10 },
    ],
  },
  {
    title: 'Spanish Basics',
    category: 'Languages',
    difficulty: 'easy',
    description: 'Greetings, numbers and everyday phrases.',
    isPublished: false,
    settings: { timePerQuestion: 25, passingScore: 50 },
    questions: [
      { type: 'multiple_choice', question: 'How do you say "good morning"?', options: ['Buenas noches', 'Buenos días', 'Hasta luego', 'Por favor'], correctAnswer: 1, points: 5 },
      { type: 'short_answer', question: 'What is the Spanish word for "water"?', correctAnswer: ['agua'], points: 5 },
    ],
  },
];

/**
 * Seed using an already-open connection. Exported so the server can bootstrap a
 * demo dataset when it starts its own in-memory database (zero-setup demo).
 */
export async function seedDatabase({ keep = false } = {}) {
  if (!keep) {
    await Promise.all([
      User.deleteMany({}),
      Category.deleteMany({}),
      Subject.deleteMany({}),
      Quiz.deleteMany({}),
      Result.deleteMany({}),
      Notification.deleteMany({}),
    ]);
    logger.info('Existing collections cleared');
  }

  const [admin, teacher, teacher2, ...students] = await User.create(
    [
      { username: 'admin', email: 'admin@cite.edu', password: DEMO_PASSWORD, role: ROLES.ADMIN, profile: { firstName: 'Ada', lastName: 'Admin', timezone: 'UTC' }, academic: { department: 'CITE' }, security: { emailVerified: true } },
      { username: 'teacher', email: 'teacher@cite.edu', password: DEMO_PASSWORD, role: ROLES.TEACHER, profile: { firstName: 'Grace', lastName: 'Hopper', timezone: 'UTC' }, academic: { teacherId: 'CITE-F-001', department: 'CITE' }, security: { emailVerified: true } },
      { username: 'teacher2', email: 'professor@cite.edu', password: DEMO_PASSWORD, role: ROLES.TEACHER, profile: { firstName: 'Alan', lastName: 'Turing' }, academic: { teacherId: 'CITE-F-002', department: 'CITE' }, security: { emailVerified: true } },
      { username: 'student', email: 'student@cite.edu', password: DEMO_PASSWORD, role: ROLES.STUDENT, profile: { firstName: 'Maya', lastName: 'Santos', timezone: 'Asia/Manila' }, academic: { studentId: '2026-00101', section: 'BSIT-3A', program: 'BSIT', yearLevel: '3rd year', department: 'CITE' } },
      { username: 'student2', email: 'student2@cite.edu', password: DEMO_PASSWORD, role: ROLES.STUDENT, profile: { firstName: 'Liam', lastName: 'Cruz' }, academic: { studentId: '2026-00102', section: 'BSIT-3A', program: 'BSIT', yearLevel: '3rd year', department: 'CITE' } },
      { username: 'student3', email: 'student3@cite.edu', password: DEMO_PASSWORD, role: ROLES.STUDENT, profile: { firstName: 'Noor', lastName: 'Hassan' }, academic: { studentId: '2026-00201', section: 'BSIT-3B', program: 'BSIT', yearLevel: '3rd year', department: 'CITE' } },
    ],
    { ordered: true },
  );

  const categories = await Category.create(CATEGORIES);
  const categoryByName = new Map(categories.map((c) => [c.name, c]));

  const userByName = new Map([admin, teacher, teacher2, ...students].map((u) => [u.username, u]));

  // CITE-style subjects. Deterministic demo enrollment codes are printed below.
  const subjectSeeds = [
    {
      subjectCode: 'CS101',
      subjectName: 'Programming 1',
      description: 'Algorithms, JavaScript fundamentals and problem solving for first-year CITE students.',
      section: 'BSIT-3A',
      program: 'BSIT',
      teacher: 'teacher',
      category: 'Programming',
      color: '#f97316',
      code: 'CITE-CS101',
      students: ['student', 'student2'],
    },
    {
      subjectCode: 'IT201',
      subjectName: 'Information Management',
      description: 'Databases, ER modelling and the systems that keep a department running.',
      section: 'BSIT-3A',
      program: 'BSIT',
      teacher: 'teacher',
      category: 'Programming',
      color: '#fbbf24',
      code: 'CITE-IT201',
      students: ['student', 'student2'],
    },
    {
      subjectCode: 'CS103',
      subjectName: 'Discrete Structures',
      description: 'Logic, sets, graphs and proofs — taught to the other CITE section.',
      section: 'BSIT-3B',
      program: 'BSIT',
      teacher: 'teacher2',
      category: 'Mathematics',
      color: '#f59e0b',
      code: 'CITE-CS103',
      students: ['student3'],
    },
  ];

  const subjects = [];
  for (const seed of subjectSeeds) {
    const subject = await Subject.create({
      subjectCode: seed.subjectCode,
      subjectName: seed.subjectName,
      description: seed.description,
      section: seed.section,
      program: seed.program,
      teacher: userByName.get(seed.teacher)._id,
      category: categoryByName.get(seed.category)?._id || null,
      color: seed.color,
      enrollmentCode: {
        token: seed.code,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        rotatedAt: new Date(),
      },
      students: seed.students.map((username) => ({
        student: userByName.get(username)._id,
        enrolledAt: new Date(),
        method: 'qr',
        status: 'active',
      })),
    });
    subjects.push(subject);
  }

  const cs101 = subjects.find((s) => s.subjectCode === 'CS101');

  logger.info(`Created ${1} admin, 2 teachers, ${students.length} students and ${categories.length} categories`);
  logger.info(`Created ${subjects.length} subjects (CS101, IT201, CS103)`);

  const createdQuizzes = [];

  for (const definition of QUIZZES) {
    const { category: categoryName, questions, isPublished = true, ...rest } = definition;
    const quiz = await Quiz.create({
      ...rest,
      category: categoryByName.get(categoryName)._id,
      teacher: teacher._id,
      isPublished,
      publishedAt: isPublished ? new Date() : null,
      questions: questions.map((q, index) => ({
        ...q,
        type: q.type,
        options: (q.options || []).map((text) => ({ text })),
        order: index,
        difficulty: rest.difficulty || 'medium',
        timeLimit: rest.settings?.timePerQuestion || 60,
      })),
    });
    createdQuizzes.push(quiz);
  }

  // Pin the programming quiz to CS101 so QR enrollment gating is demonstrable.
  await Quiz.updateOne({ title: 'JavaScript Essentials' }, { subject: cs101._id });

  await Category.updateMany({}, [{ $set: { quizCount: 0 } }]);
  for (const quiz of createdQuizzes) {
    await Category.updateOne({ _id: quiz.category }, { $inc: { quizCount: 1 } });
  }

  // Demo attempts so analytics and dashboards have something to show.
  const published = createdQuizzes.filter((q) => q.isPublished);
  let attemptTotal = 0;

  for (const [studentIndex, student] of students.entries()) {
    for (const [quizIndex, quiz] of published.entries()) {
      if ((studentIndex + quizIndex) % 2 === 1 && studentIndex > 0) continue;

      const correctRatio = 0.45 + ((studentIndex + quizIndex) % 5) * 0.12;
      let score = 0;
      let maxScore = 0;
      let correctCount = 0;

      const answers = quiz.questions.map((question, qIndex) => {
        maxScore += question.points;
        const shouldBeCorrect = qIndex / quiz.questions.length < correctRatio;
        if (shouldBeCorrect) {
          score += question.points;
          correctCount += 1;
        }

        let studentAnswer = null;
        if (question.type === 'multiple_choice') {
          const optionCount = Math.max(1, (question.options || []).length);
          studentAnswer = shouldBeCorrect
            ? question.correctAnswer
            : (Number(question.correctAnswer) + 1) % optionCount;
        } else if (question.type === 'true_false') {
          studentAnswer = shouldBeCorrect ? question.correctAnswer : !question.correctAnswer;
        } else if (question.type === 'short_answer') {
          if (!shouldBeCorrect) studentAnswer = 'Not sure';
          else if (Array.isArray(question.correctAnswer)) studentAnswer = question.correctAnswer[0];
          else studentAnswer = question.correctAnswer;
        } else {
          studentAnswer = 'A short essay answer covering the main idea.';
        }

        return {
          question: question._id,
          questionText: question.question,
          type: question.type,
          studentAnswer,
          isCorrect: question.type === 'essay' ? null : shouldBeCorrect,
          pointsEarned: shouldBeCorrect ? question.points : 0,
          maxPoints: question.points,
          needsManualGrading: question.type === 'essay',
          feedback: '',
        };
      });

      const result = new Result({
        quiz: quiz._id,
        student: student._id,
        teacher: quiz.teacher,
        answers,
        attemptNumber: 1,
        passingScore: quiz.settings.passingScore,
        status: quiz.questions.some((q) => q.type === 'essay') ? 'submitted' : 'graded',
        timeSpent: 120 + quizIndex * 35 + studentIndex * 20,
        startedAt: new Date(Date.now() - (studentIndex + 1) * 86400000),
        completedAt: new Date(Date.now() - (studentIndex + 1) * 86400000 + 900000),
        gradedAt: quiz.questions.some((q) => q.type === 'essay') ? null : new Date(),
      });
      await result.save();
      attemptTotal += 1;
    }
  }

  for (const quiz of createdQuizzes) {
    quiz.analytics.totalAttempts = attemptTotal ? Math.max(1, Math.round(attemptTotal / createdQuizzes.length)) : 0;
    await quiz.save();
    await recomputeQuizAnalytics(quiz._id);
  }

  for (const student of students) {
    await recomputeStudentStats(student._id);
    await Notification.create({
      user: student._id,
      type: 'system',
      title: 'Welcome to CITE BrainCheck',
      message: 'Browse the catalogue and take your first quiz — your streak starts today.',
      link: '/quizzes',
    });
  }

  logger.info(`Seeded ${createdQuizzes.length} quizzes and ${attemptTotal} graded attempts`);
  logger.info('Demo accounts (password: Password123)');
  logger.info('  admin@cite.edu    · administrator');
  logger.info('  teacher@cite.edu  · teacher (CS101, IT201)');
  logger.info('  professor@cite.edu · teacher (CS103)');
  logger.info('  student@cite.edu  · student (BSIT-3A)');
  logger.info('  student3@cite.edu · student (BSIT-3B)');
  logger.info('Demo enrollment codes: CITE-CS101 · CITE-IT201 · CITE-CS103');
}

async function runSeedCli() {
  // This wipes collections and installs demo accounts with a known password.
  // Never let it near a real deployment by accident.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== 'true') {
    logger.error(
      'Refusing to seed demo data with NODE_ENV=production. Use `npm run create-admin` to bootstrap a real deployment, or set ALLOW_DEMO_SEED=true if you truly want the demo cohort here.',
    );
    process.exit(1);
  }

  await connectDB({ allowMemory: process.env.USE_MEMORY_DB === 'true' });
  await seedDatabase({ keep: process.argv.includes('--keep') });
  await disconnectDB();
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runSeedCli().catch(async (err) => {
    logger.error(`Seed failed: ${err.stack || err.message}`);
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
}
