import request from 'supertest';
import app from '../../app.js';
import { setupTestDb, clearTestDb, teardownTestDb, seedUser, seedCategory } from '../helpers/db.js';

let teacherAgent;
let studentAgent;
let category;

beforeAll(async () => {
  await setupTestDb();
}, 120000);

beforeEach(async () => {
  await clearTestDb();
  await seedUser({ username: 'teacher1', email: 'teacher1@test.dev', role: 'teacher', firstName: 'Grace' });
  await seedUser({ username: 'student1', email: 'student1@test.dev', role: 'student', firstName: 'Maya' });
  category = await seedCategory({ name: 'Science' });

  teacherAgent = request.agent(app);
  studentAgent = request.agent(app);

  await teacherAgent.post('/api/auth/login').send({ identifier: 'teacher1@test.dev', password: 'Password123' }).expect(200);
  await studentAgent.post('/api/auth/login').send({ identifier: 'student1@test.dev', password: 'Password123' }).expect(200);
});

afterAll(async () => {
  await teardownTestDb();
});

/** Quiz with one of each auto-graded type plus an essay (45 points total). */
const quizPayload = () => ({
  title: 'Solar System Basics',
  description: 'Planets and orbits',
  category: category._id.toString(),
  difficulty: 'easy',
  isPublished: true,
  settings: {
    timePerQuestion: 60,
    passingScore: 60,
    allowRetakes: false,
    maxAttempts: 1,
    randomizeQuestions: false,
    randomizeOptions: false,
    showCorrectAnswers: true,
  },
  questions: [
    {
      type: 'multiple_choice',
      question: 'Which planet is known as the Red Planet?',
      options: [{ text: 'Venus' }, { text: 'Mars' }, { text: 'Jupiter' }],
      correctAnswer: 1,
      points: 10,
    },
    { type: 'true_false', question: 'Jupiter is the largest planet.', correctAnswer: true, points: 5 },
    { type: 'short_answer', question: 'Which planet is closest to the Sun?', correctAnswer: ['mercury'], points: 10 },
    { type: 'essay', question: 'Explain why seasons happen.', points: 20 },
  ],
});

async function createQuiz(overrides = {}) {
  const res = await teacherAgent
    .post('/api/teacher/quizzes')
    .send({ ...quizPayload(), ...overrides })
    .expect(201);
  return res.body.data;
}

describe('quiz authoring', () => {
  test('teacher creates and publishes a quiz', async () => {
    const quiz = await createQuiz();
    expect(quiz.isPublished).toBe(true);
    expect(quiz.questions).toHaveLength(4);
    expect(quiz.slug).toMatch(/solar-system-basics/);

    const list = await teacherAgent.get('/api/teacher/quizzes').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.meta.total).toBe(1);
  });

  test('rejects a quiz with no questions', async () => {
    const res = await teacherAgent
      .post('/api/teacher/quizzes')
      .send({ ...quizPayload(), questions: [] })
      .expect(422);

    expect(res.body.error.details.some((d) => d.field === 'questions')).toBe(true);
  });

  test('rejects invalid multiple-choice answer keys', async () => {
    const payload = quizPayload();
    payload.questions = [{ type: 'multiple_choice', question: 'Pick', options: [{ text: 'A' }, { text: 'B' }], correctAnswer: 9 }];

    const res = await teacherAgent.post('/api/teacher/quizzes').send(payload).expect(422);
    expect(res.body.error.details.some((d) => d.field.includes('correctAnswer'))).toBe(true);
  });

  test('students cannot author quizzes', async () => {
    await studentAgent.post('/api/teacher/quizzes').send(quizPayload()).expect(403);
  });

  test('another teacher cannot edit a quiz they do not own', async () => {
    const quiz = await createQuiz();
    await seedUser({ username: 'teacher2', email: 'teacher2@test.dev', role: 'teacher' });

    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ identifier: 'teacher2@test.dev', password: 'Password123' }).expect(200);

    await otherAgent.patch(`/api/teacher/quizzes/${quiz._id}`).send({ title: 'Hijacked' }).expect(403);
  });
});

describe('attempt lifecycle', () => {
  test('student starts, submits and is graded server-side', async () => {
    const quiz = await createQuiz();

    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    const { quiz: view, attemptId } = start.body.data;

    expect(view.questions).toHaveLength(4);
    expect(JSON.stringify(view)).not.toContain('correctAnswer');
    expect(start.body.data.deadline).toBeTruthy();

    const byType = Object.fromEntries(view.questions.map((q) => [q.type, q]));

    const submit = await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({
        attemptId,
        timeSpent: 120,
        answers: [
          { questionId: byType.multiple_choice.id, answer: 1 },
          { questionId: byType.true_false.id, answer: true },
          { questionId: byType.short_answer.id, answer: 'Mercury' },
          { questionId: byType.essay.id, answer: 'The Earth is tilted on its axis.' },
        ],
      })
      .expect(200);

    const { result, summary, pendingReview } = submit.body.data;

    expect(pendingReview).toBe(true); // essay needs a human
    expect(result.status).toBe('submitted');
    expect(summary).toMatchObject({ score: 25, maxScore: 45, correctCount: 3, totalQuestions: 4 });
    expect(summary.percentage).toBeCloseTo(55.56, 1);
    expect(result.answers.find((a) => a.type === 'short_answer').isCorrect).toBe(true);
    expect(result.answers.find((a) => a.type === 'essay').needsManualGrading).toBe(true);
  });

  test('wrong answers score zero and the grade is recorded', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    const byType = Object.fromEntries(start.body.data.quiz.questions.map((q) => [q.type, q]));

    const submit = await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({
        attemptId: start.body.data.attemptId,
        answers: [
          { questionId: byType.multiple_choice.id, answer: 0 },
          { questionId: byType.true_false.id, answer: false },
        ],
      })
      .expect(200);

    expect(submit.body.data.summary.score).toBe(0);
    expect(submit.body.data.summary.passed).toBe(false);
  });

  test('submitting twice is rejected', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);

    await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({ attemptId: start.body.data.attemptId, answers: [] })
      .expect(200);

    const again = await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({ attemptId: start.body.data.attemptId, answers: [] })
      .expect(409);

    expect(again.body.error.code).toBe('CONFLICT');
    expect(again.body.error.message).toMatch(/already been submitted/i);
  });

  test('retakes respect maxAttempts', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({ attemptId: start.body.data.attemptId, answers: [] })
      .expect(200);

    const res = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(403);
    expect(res.body.error.message).toMatch(/retakes|attempts/i);
  });

  test('unpublished quizzes cannot be started by students', async () => {
    const quiz = await createQuiz({ isPublished: false });
    const res = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(403);
    expect(res.body.error.message).toMatch(/not published/i);
  });

  test('students only see their own results', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    const submit = await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({ attemptId: start.body.data.attemptId, answers: [] })
      .expect(200);

    const resultId = submit.body.data.result._id;

    await seedUser({ username: 'student9', email: 'student9@test.dev', role: 'student' });
    const otherAgent = request.agent(app);
    await otherAgent.post('/api/auth/login').send({ identifier: 'student9@test.dev', password: 'Password123' }).expect(200);

    const res = await otherAgent.get(`/api/student/results/${resultId}`).expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');

    await studentAgent.get(`/api/student/results/${resultId}`).expect(200);
  });
});

describe('grading, analytics and dashboards', () => {
  test('teacher grades an essay and the score is recalculated', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    const byType = Object.fromEntries(start.body.data.quiz.questions.map((q) => [q.type, q]));

    await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({
        attemptId: start.body.data.attemptId,
        answers: [
          { questionId: byType.multiple_choice.id, answer: 1 },
          { questionId: byType.true_false.id, answer: true },
          { questionId: byType.short_answer.id, answer: 'mercury' },
          { questionId: byType.essay.id, answer: 'Axial tilt.' },
        ],
      })
      .expect(200);

    const queue = await teacherAgent.get('/api/teacher/grading').expect(200);
    expect(queue.body.data).toHaveLength(1);
    const pending = queue.body.data[0];
    expect(pending.pendingAnswers).toBe(1);

    const grade = await teacherAgent
      .post(`/api/teacher/results/${pending._id}/grade`)
      .send({ grades: [{ questionId: byType.essay.id, pointsEarned: 18, feedback: 'Nice explanation.' }] })
      .expect(200);

    expect(grade.body.data.status).toBe('graded');
    expect(grade.body.data.score.totalScore).toBe(43);
    expect(grade.body.data.score.percentage).toBeCloseTo(95.56, 1);
    expect(grade.body.data.score.passed).toBe(true);
  });

  test('quiz analytics summarises attempts and question difficulty', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    const byType = Object.fromEntries(start.body.data.quiz.questions.map((q) => [q.type, q]));

    await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({
        attemptId: start.body.data.attemptId,
        answers: [
          { questionId: byType.multiple_choice.id, answer: 1 },
          { questionId: byType.true_false.id, answer: false },
        ],
      })
      .expect(200);

    const res = await teacherAgent.get(`/api/teacher/quizzes/${quiz._id}/analytics`).expect(200);
    expect(res.body.data.summary.attempts).toBe(1);
    expect(res.body.data.summary.averageScore).toBeCloseTo(22.22, 1);

    const hardest = res.body.data.questionStats;
    expect(Array.isArray(hardest)).toBe(true);
    expect(hardest.length).toBeGreaterThan(0);
    expect(hardest[0]).toHaveProperty('correctRate');
  });

  test('student dashboard and stats expose progress', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    const byType = Object.fromEntries(start.body.data.quiz.questions.map((q) => [q.type, q]));

    await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({
        attemptId: start.body.data.attemptId,
        answers: [
          { questionId: byType.multiple_choice.id, answer: 1 },
          { questionId: byType.true_false.id, answer: true },
        ],
      })
      .expect(200);

    const dashboard = await studentAgent.get('/api/student/dashboard').expect(200);
    expect(dashboard.body.data.summary.quizzesTaken).toBe(1);
    expect(dashboard.body.data.recentResults).toHaveLength(1);
    expect(dashboard.body.data.summary.currentStreak).toBeGreaterThanOrEqual(1);

    const stats = await studentAgent.get('/api/student/stats').expect(200);
    expect(stats.body.data.summary.quizzesTaken).toBe(1);
    expect(stats.body.data.byCategory.length).toBeGreaterThan(0);
  });

  test('teacher dashboard reports the grading queue', async () => {
    const quiz = await createQuiz();
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).send({}).expect(200);
    await studentAgent
      .post(`/api/student/quizzes/${quiz._id}/submit`)
      .send({ attemptId: start.body.data.attemptId, answers: [] })
      .expect(200);

    const res = await teacherAgent.get('/api/teacher/dashboard').expect(200);
    expect(res.body.data.summary.quizzes).toBe(1);
    expect(res.body.data.summary.pendingGrading).toBe(1);
    expect(res.body.data.recentQuizzes).toHaveLength(1);
  });
});

describe('public catalogue', () => {
  test('lists published quizzes and hides answer keys', async () => {
    await createQuiz();
    await createQuiz({ title: 'Draft quiz', isPublished: false });

    const list = await request(app).get('/api/quizzes').expect(200);
    expect(list.body.data).toHaveLength(1);

    const detail = await request(app).get(`/api/quizzes/${list.body.data[0]._id}`).expect(200);
    expect(JSON.stringify(detail.body.data)).not.toContain('correctAnswer');

    const questions = await request(app).get(`/api/quizzes/${list.body.data[0]._id}/questions`).expect(200);
    expect(questions.body.data.questions).toHaveLength(4);
  });

  test('unpublished quizzes are 404 for anonymous visitors', async () => {
    const quiz = await createQuiz({ isPublished: false });
    await request(app).get(`/api/quizzes/${quiz._id}`).expect(404);
  });

  test('categories and platform stats are public', async () => {
    await createQuiz();
    const categories = await request(app).get('/api/categories').expect(200);
    expect(categories.body.data[0]).toMatchObject({ name: 'Science', quizCount: 1 });

    const stats = await request(app).get('/api/stats').expect(200);
    expect(stats.body.data.quizzes).toBe(1);
  });
});
