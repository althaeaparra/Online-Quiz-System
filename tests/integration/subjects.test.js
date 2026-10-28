import request from 'supertest';
import app from '../../app.js';
import { Subject } from '../../models/Subject.js';
import { setupTestDb, clearTestDb, teardownTestDb, seedUser, seedCategory } from '../helpers/db.js';

let teacherAgent;
let otherTeacherAgent;
let studentAgent;
let classmateAgent;
let otherSectionAgent;
let category;

const SUBJECT = {
  subjectCode: 'CS101',
  subjectName: 'Programming 1',
  description: 'Algorithms and JavaScript fundamentals',
  section: 'BSIT-3A',
  program: 'BSIT',
  enrollment: { maxStudents: 50, qrExpiresInHours: 24 },
};

beforeAll(async () => {
  await setupTestDb();
}, 120000);

beforeEach(async () => {
  await clearTestDb();

  await seedUser({ username: 'teacher1', email: 'teacher1@test.dev', role: 'teacher', firstName: 'Grace' });
  await seedUser({ username: 'teacher2', email: 'teacher2@test.dev', role: 'teacher', firstName: 'Alan' });
  await seedUser({
    username: 'student1',
    email: 'student1@test.dev',
    firstName: 'Maya',
    academic: { studentId: '2026-00101', section: 'BSIT-3A', program: 'BSIT' },
  });
  await seedUser({
    username: 'student2',
    email: 'student2@test.dev',
    firstName: 'Liam',
    academic: { studentId: '2026-00102', section: 'BSIT-3A', program: 'BSIT' },
  });
  await seedUser({
    username: 'student3',
    email: 'student3@test.dev',
    firstName: 'Noor',
    academic: { studentId: '2026-00201', section: 'BSIT-3B', program: 'BSIT' },
  });
  category = await seedCategory({ name: 'Programming' });

  teacherAgent = request.agent(app);
  otherTeacherAgent = request.agent(app);
  studentAgent = request.agent(app);
  classmateAgent = request.agent(app);
  otherSectionAgent = request.agent(app);

  await teacherAgent.post('/api/auth/login').send({ identifier: 'teacher1@test.dev', password: 'Password123' }).expect(200);
  await otherTeacherAgent.post('/api/auth/login').send({ identifier: 'teacher2@test.dev', password: 'Password123' }).expect(200);
  await studentAgent.post('/api/auth/login').send({ identifier: 'student1@test.dev', password: 'Password123' }).expect(200);
  await classmateAgent.post('/api/auth/login').send({ identifier: 'student2@test.dev', password: 'Password123' }).expect(200);
  await otherSectionAgent.post('/api/auth/login').send({ identifier: 'student3@test.dev', password: 'Password123' }).expect(200);
});

afterAll(async () => {
  await teardownTestDb();
});

async function createSubject(agent = teacherAgent, overrides = {}) {
  const res = await agent
    .post('/api/teacher/subjects')
    .send({ ...SUBJECT, ...overrides })
    .expect(201);
  return res.body.data;
}

async function issueQr(agent, subjectId) {
  const res = await agent.post(`/api/teacher/subjects/${subjectId}/qr`).send({}).expect(200);
  return res.body.data;
}

const enroll = (agent, code) => agent.post('/api/student/enroll').send({ code });

const quizPayload = (subjectId) => ({
  title: 'JavaScript Essentials',
  description: 'Closures and block scope',
  category: category._id.toString(),
  subject: subjectId,
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
      question: 'Which keyword creates a block-scoped binding?',
      options: [{ text: 'var' }, { text: 'let' }, { text: 'function' }],
      correctAnswer: 1,
      points: 10,
    },
  ],
});

async function createSubjectQuiz(subjectId) {
  const res = await teacherAgent.post('/api/teacher/quizzes').send(quizPayload(subjectId)).expect(201);
  return res.body.data;
}

describe('role-scoped authentication', () => {
  test('a student account cannot sign in through the teacher portal', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'student1@test.dev', password: 'Password123', expectedRole: 'teacher' })
      .expect(403);

    expect(res.body.error.message).toMatch(/teacher sign-in page/i);
  });

  test('a teacher account cannot sign in through the student portal', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'teacher1@test.dev', password: 'Password123', expectedRole: 'student' })
      .expect(403);

    expect(res.body.error.message).toMatch(/student sign-in page/i);
  });

  test('student registration requires a student ID and section', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'newbie',
        email: 'newbie@test.dev',
        password: 'Password123',
        role: 'student',
        profile: { firstName: 'New' },
      })
      .expect(422);

    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toContain('academic.studentId');
    expect(fields).toContain('academic.section');
  });

  test('registers a student with academic details and rejects a reused student ID', async () => {
    const payload = {
      username: 'newbie',
      email: 'newbie@test.dev',
      password: 'Password123',
      role: 'student',
      profile: { firstName: 'New', lastName: 'Student' },
      academic: { studentId: '2026-00999', section: 'BSIT-3A', program: 'BSIT', yearLevel: '1st year' },
    };

    const res = await request(app).post('/api/auth/register').send(payload).expect(201);
    expect(res.body.data.user).toMatchObject({
      role: 'student',
      academic: { studentId: '2026-00999', section: 'BSIT-3A', department: 'CITE' },
    });

    const duplicate = await request(app)
      .post('/api/auth/register')
      .send({ ...payload, username: 'someoneelse', email: 'other@test.dev' })
      .expect(409);
    expect(duplicate.body.error.message).toMatch(/student ID/i);
  });

  test('teacher registration requires a teacher ID and department', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        username: 'newteacher',
        email: 'newteacher@test.dev',
        password: 'Password123',
        role: 'teacher',
        profile: { firstName: 'New' },
      })
      .expect(422);

    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toContain('academic.teacherId');
    expect(fields).toContain('academic.department');
  });
});

describe('subjects and QR enrollment', () => {
  test('creates a subject, lists it and rejects a duplicate code for the section', async () => {
    const subject = await createSubject();
    expect(subject).toMatchObject({ subjectCode: 'CS101', section: 'BSIT-3A', enrolledCount: 0 });
    expect(subject.enrollmentCode?.token).toBeUndefined();

    const list = await teacherAgent.get('/api/teacher/subjects').expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].quizCount).toBe(0);

    const duplicate = await teacherAgent.post('/api/teacher/subjects').send(SUBJECT).expect(409);
    expect(duplicate.body.error.message).toMatch(/already have CS101/i);
  });

  test('issues a QR code with a join URL and rotates invalidating the old code', async () => {
    const subject = await createSubject();
    const issued = await issueQr(teacherAgent, subject.id);

    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(issued.url).toContain(`/#/enroll/${issued.code}`);
    expect(issued.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(new Date(issued.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const preview = await studentAgent.post('/api/student/enroll/preview').send({ code: issued.code }).expect(200);
    expect(preview.body.data.subject.subjectCode).toBe('CS101');
    expect(preview.body.data.subject.teacherName).toBe('Grace User');

    const rotated = await issueQr(teacherAgent, subject.id);
    expect(rotated.code).not.toBe(issued.code);

    await studentAgent.post('/api/student/enroll/preview').send({ code: issued.code }).expect(404);
    await studentAgent.post('/api/student/enroll/preview').send({ code: rotated.code }).expect(200);
  });

  test('a student in the matching section joins once and sees the subject', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);

    const joined = await enroll(studentAgent, code).expect(201);
    expect(joined.body.data.alreadyEnrolled).toBe(false);
    expect(joined.body.data.subject.enrolledCount).toBe(1);

    const again = await enroll(studentAgent, code).expect(200);
    expect(again.body.data.alreadyEnrolled).toBe(true);
    expect(again.body.data.subject.enrolledCount).toBe(1);

    const mine = await studentAgent.get('/api/student/subjects').expect(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({
      subjectCode: 'CS101',
      teacherName: 'Grace User',
      myEnrollment: { status: 'active', blocked: false },
    });
  });

  test('rejects a student from another section', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);

    const res = await enroll(otherSectionAgent, code).expect(403);
    expect(res.body.error.message).toMatch(/section BSIT-3A/i);

    const mine = await otherSectionAgent.get('/api/student/subjects').expect(200);
    expect(mine.body.data).toHaveLength(0);
  });

  test('rejects an expired code and a full subject', async () => {
    const subject = await createSubject(teacherAgent, { enrollment: { maxStudents: 1, qrExpiresInHours: 1 } });
    const { code } = await issueQr(teacherAgent, subject.id);

    await enroll(studentAgent, code).expect(201);
    const full = await enroll(classmateAgent, code).expect(403);
    expect(full.body.error.message).toMatch(/full/i);

    await Subject.updateOne(
      { _id: subject.id },
      { $set: { 'enrollmentCode.expiresAt': new Date(Date.now() - 60_000) } },
    );
    const expired = await enroll(classmateAgent, code).expect(403);
    expect(expired.body.error.message).toMatch(/expired/i);
  });

  test('holds enrollment for approval when the subject requires it', async () => {
    const subject = await createSubject(teacherAgent, {
      enrollment: { maxStudents: 50, requireApproval: true },
    });
    const { code } = await issueQr(teacherAgent, subject.id);

    const joined = await enroll(studentAgent, code).expect(201);
    expect(joined.body.data.pendingApproval).toBe(true);

    const quiz = await createSubjectQuiz(subject.id);
    const start = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(403);
    expect(start.body.error.message).toMatch(/waiting for teacher approval/i);
  });

  test('only the owning teacher can read or rotate a subject', async () => {
    const subject = await createSubject();

    await otherTeacherAgent.get(`/api/teacher/subjects/${subject.id}`).expect(403);
    await otherTeacherAgent.post(`/api/teacher/subjects/${subject.id}/qr`).send({}).expect(403);

    const list = await otherTeacherAgent.get('/api/teacher/subjects').expect(200);
    expect(list.body.data).toHaveLength(0);

    await studentAgent.get('/api/teacher/subjects').expect(403);
  });
});

describe('subject-gated quizzes and blocking', () => {
  test('a subject quiz is hidden from non-members and startable once enrolled', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);
    const quiz = await createSubjectQuiz(subject.id);

    const before = await studentAgent.get('/api/student/quizzes').expect(200);
    expect(before.body.data.map((q) => q._id)).not.toContain(quiz._id);

    const denied = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(403);
    expect(denied.body.error.message).toMatch(/enrolled students/i);

    await enroll(studentAgent, code).expect(201);

    const after = await studentAgent.get('/api/student/quizzes').expect(200);
    const listed = after.body.data.find((q) => q._id === quiz._id);
    expect(listed).toBeTruthy();
    expect(listed.questionCount).toBe(1);
    expect(listed.subject?.subjectCode).toBe('CS101');

    const started = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(200);
    expect(started.body.data.attemptId).toBeTruthy();
  });

  test('blocking removes the quiz, refuses starts, and keeps the roster history', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);
    const quiz = await createSubjectQuiz(subject.id);
    await enroll(studentAgent, code).expect(201);

    const studentId = (await studentAgent.get('/api/auth/me')).body.data.id;
    const blocked = await teacherAgent
      .post(`/api/teacher/subjects/${subject.id}/students/${studentId}/block`)
      .send({ reason: 'Academic integrity review' })
      .expect(200);

    const row = blocked.body.data.students.find((s) => s.student.id === studentId);
    expect(row).toMatchObject({ blocked: true, blockReason: 'Academic integrity review' });
    expect(blocked.body.data.enrolledCount).toBe(1); // still on the roster

    const denied = await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(403);
    expect(denied.body.error.message).toMatch(/blocked you/i);

    const catalogue = await studentAgent.get('/api/student/quizzes').expect(200);
    expect(catalogue.body.data.map((q) => q._id)).not.toContain(quiz._id);

    // A blocked student cannot rejoin with a fresh code either.
    const rejoin = await enroll(studentAgent, code).expect(403);
    expect(rejoin.body.error.message).toMatch(/blocked/i);

    await teacherAgent
      .delete(`/api/teacher/subjects/${subject.id}/students/${studentId}/block`)
      .expect(200);

    await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(200);
  });

  test('removing a student revokes access until they re-enroll', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);
    const quiz = await createSubjectQuiz(subject.id);
    await enroll(studentAgent, code).expect(201);

    const studentId = (await studentAgent.get('/api/auth/me')).body.data.id;
    const removed = await teacherAgent
      .delete(`/api/teacher/subjects/${subject.id}/students/${studentId}`)
      .expect(200);
    expect(removed.body.data.students).toHaveLength(0);

    await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(403);
    await enroll(studentAgent, code).expect(201);
    await studentAgent.post(`/api/student/quizzes/${quiz._id}/start`).expect(200);
  });

  test('a non-owner cannot block or remove another teacher’s student', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);
    await enroll(studentAgent, code).expect(201);
    const studentId = (await studentAgent.get('/api/auth/me')).body.data.id;

    await otherTeacherAgent
      .post(`/api/teacher/subjects/${subject.id}/students/${studentId}/block`)
      .send({})
      .expect(403);
    await otherTeacherAgent
      .delete(`/api/teacher/subjects/${subject.id}/students/${studentId}`)
      .expect(403);
  });

  test('exports the roster as a CSV with status and block details', async () => {
    const subject = await createSubject();
    const { code } = await issueQr(teacherAgent, subject.id);
    await enroll(studentAgent, code).expect(201);
    await enroll(classmateAgent, code).expect(201);

    const studentId = (await studentAgent.get('/api/auth/me')).body.data.id;
    await teacherAgent
      .post(`/api/teacher/subjects/${subject.id}/students/${studentId}/block`)
      .send({ reason: 'Academic integrity review' })
      .expect(200);

    const res = await teacherAgent.get(`/api/teacher/subjects/${subject.id}/roster`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="CS101-BSIT-3A-roster-\d+\.csv"/,
    );

    const lines = res.text.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('name,student_id,section,status,blocked_reason,enrolled_at');
    expect(lines).toHaveLength(3);

    // Alphabetical by name: Liam before Maya.
    expect(lines[1]).toMatch(/^Liam User,2026-00102,BSIT-3A,active,,\d{4}-\d{2}-\d{2}T/);
    expect(lines[2]).toMatch(/^Maya User,2026-00101,BSIT-3A,blocked,Academic integrity review,\d{4}-\d{2}-\d{2}T/);

    // Another teacher cannot read or export this roster.
    await otherTeacherAgent.get(`/api/teacher/subjects/${subject.id}/roster`).expect(403);
  });

  test('teacher can pin a quiz only to their own subject', async () => {
    const subject = await createSubject();
    await otherTeacherAgent.post('/api/teacher/quizzes').send(quizPayload(subject.id)).expect(403);
  });
});

describe('teacher-authored categories', () => {
  test('creates a custom category and reuses it by name', async () => {
    const created = await teacherAgent
      .post('/api/teacher/categories')
      .send({ name: 'Data Structures', color: '#f97316' })
      .expect(201);

    expect(created.body.data).toMatchObject({ name: 'Data Structures', slug: 'data-structures' });

    const reused = await otherTeacherAgent
      .post('/api/teacher/categories')
      .send({ name: 'Data Structures' })
      .expect(200);
    expect(reused.body.data.id).toBe(created.body.data.id);

    const publicList = await request(app).get('/api/categories').expect(200);
    expect(publicList.body.data.map((c) => c.name)).toContain('Data Structures');
  });
});
