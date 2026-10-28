import request from 'supertest';
import app from '../../app.js';
import { setupTestDb, clearTestDb, teardownTestDb, seedUser, seedCategory } from '../helpers/db.js';
import { Quiz } from '../../models/Quiz.js';
import { Category } from '../../models/Category.js';
import { Subject } from '../../models/Subject.js';

let adminAgent;
let studentAgent;
let student;
let adminUser;

beforeAll(async () => {
  await setupTestDb();
}, 120000);

beforeEach(async () => {
  await clearTestDb();
  adminUser = await seedUser({ username: 'root', email: 'root@test.dev', role: 'admin', firstName: 'Ada' });
  student = await seedUser({ username: 'kim', email: 'kim@test.dev', role: 'student', firstName: 'Kim' });

  adminAgent = request.agent(app);
  studentAgent = request.agent(app);

  await adminAgent.post('/api/auth/login').send({ identifier: 'root@test.dev', password: 'Password123' }).expect(200);
  await studentAgent.post('/api/auth/login').send({ identifier: 'kim@test.dev', password: 'Password123' }).expect(200);
});

afterAll(async () => {
  await teardownTestDb();
});

describe('role guards', () => {
  test('students cannot reach admin endpoints', async () => {
    const res = await studentAgent.get('/api/admin/users').expect(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  test('anonymous requests are rejected', async () => {
    await request(app).get('/api/admin/dashboard').expect(401);
  });
});

describe('admin dashboard & health', () => {
  test('returns platform counters', async () => {
    await seedCategory({ name: 'History' });

    const res = await adminAgent.get('/api/admin/dashboard').expect(200);
    expect(res.body.data.users.total).toBe(2);
    expect(res.body.data.users.admins).toBe(1);
    expect(res.body.data.health.database).toBe('connected');
    expect(Array.isArray(res.body.data.categories)).toBe(true);
  });

  test('reports department-wide subject, enrollment and QR activity totals', async () => {
    const now = new Date();
    await Subject.create({
      subjectCode: 'CS101',
      subjectName: 'Programming 1',
      section: 'BSIT-3A',
      program: 'BSIT',
      teacher: student._id,
      enrollmentCode: { token: 'CITE-CS101', createdAt: now, expiresAt: new Date(Date.now() + 86400000) },
      students: [{ student: student._id, status: 'active', method: 'qr' }],
    });
    await Subject.create({
      subjectCode: 'CS102',
      subjectName: 'Data Structures',
      section: 'BSIT-3B',
      teacher: student._id,
      enrollmentCode: { token: 'CITE-CS102', createdAt: now, expiresAt: new Date(Date.now() - 86400000) },
      students: [],
    });

    const res = await adminAgent.get('/api/admin/dashboard').expect(200);
    const subjects = res.body.data.subjects;

    expect(subjects).toMatchObject({
      total: 2,
      sections: 2,
      activeQrCodes: 1,
      qrIssuedInRange: 2,
      rosterEntries: 1,
      activeEnrollments: 1,
      uniqueStudents: 1,
    });
    expect(subjects.topSubjects[0]).toMatchObject({
      subjectCode: 'CS101',
      section: 'BSIT-3A',
      enrolledCount: 1,
      blockedCount: 0,
      qrActive: true,
    });
  });

  test('system health reports uptime and memory', async () => {
    const res = await adminAgent.get('/api/admin/system-health').expect(200);
    expect(res.body.data.status).toBe('healthy');
    expect(res.body.data.memory.rssMb).toBeGreaterThan(0);
    expect(res.body.data.database.ping).toBe('ok');
  });
});

describe('user administration', () => {
  test('lists, filters and searches users', async () => {
    const res = await adminAgent.get('/api/admin/users?role=student&search=kim').expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].username).toBe('kim');
    expect(res.body.data[0].password).toBeUndefined();
  });

  test('promotes a student to teacher', async () => {
    const res = await adminAgent
      .patch(`/api/admin/users/${student._id}`)
      .send({ role: 'teacher' })
      .expect(200);

    expect(res.body.data.role).toBe('teacher');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'kim@test.dev', password: 'Password123' })
      .expect(200);
    expect(login.body.data.user.role).toBe('teacher');
  });

  test('deactivates a user, who can then no longer sign in', async () => {
    await adminAgent.delete(`/api/admin/users/${student._id}`).expect(200);

    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'kim@test.dev', password: 'Password123' })
      .expect(403);

    expect(res.body.error.message).toMatch(/deactivated/i);
  });

  test('cannot demote the last active admin', async () => {
    const me = await adminAgent.get('/api/auth/me').expect(200);
    const res = await adminAgent
      .patch(`/api/admin/users/${me.body.data.id}`)
      .send({ role: 'student' })
      .expect(403);

    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('category administration', () => {
  test('creates, updates and deletes an unused category', async () => {
    const created = await adminAgent
      .post('/api/admin/categories')
      .send({ name: 'Geography', description: 'Maps and places', color: '#22d3ee', icon: 'globe' })
      .expect(201);

    expect(created.body.data.slug).toBe('geography');

    const updated = await adminAgent
      .patch(`/api/admin/categories/${created.body.data._id}`)
      .send({ description: 'Updated description' })
      .expect(200);
    expect(updated.body.data.description).toBe('Updated description');

    await adminAgent.delete(`/api/admin/categories/${created.body.data._id}`).expect(204);
    expect(await Category.countDocuments()).toBe(0);
  });

  test('refuses to delete a category that still has quizzes', async () => {
    const category = await seedCategory({ name: 'Physics' });
    await seedUser({ username: 'teach1', email: 'teach1@test.dev', role: 'teacher' });
    const teacher = await adminAgent.get('/api/admin/users?role=teacher').expect(200);

    await Quiz.create({
      title: 'Waves',
      category: category._id,
      teacher: teacher.body.data[0].id,
      questions: [{ type: 'true_false', question: 'Sound is a wave.', correctAnswer: true, points: 1 }],
    });

    const res = await adminAgent.delete(`/api/admin/categories/${category._id}`).expect(409);
    expect(res.body.error.message).toMatch(/still use this category/i);
  });

  test('rejects invalid category colours', async () => {
    const res = await adminAgent
      .post('/api/admin/categories')
      .send({ name: 'Bad Colour', color: 'purple' })
      .expect(422);
    expect(res.body.error.details.some((d) => d.field === 'color')).toBe(true);
  });
});

describe('operations', () => {
  test('features a quiz and exports a report', async () => {
    const category = await seedCategory({ name: 'Art' });
    await seedUser({ username: 'teach2', email: 'teach2@test.dev', role: 'teacher' });
    const teacherList = await adminAgent.get('/api/admin/users?role=teacher').expect(200);

    const quiz = await Quiz.create({
      title: 'Colour Theory',
      category: category._id,
      teacher: teacherList.body.data[0].id,
      isPublished: true,
      questions: [{ type: 'true_false', question: 'Red is a primary colour.', correctAnswer: true, points: 1 }],
    });

    const featured = await adminAgent
      .patch(`/api/admin/quizzes/${quiz._id}/feature`)
      .send({ isFeatured: true })
      .expect(200);
    expect(featured.body.data.isFeatured).toBe(true);

    const report = await adminAgent.get('/api/admin/reports?type=overview').expect(200);
    expect(report.body.data.totals).toMatchObject({ users: 3, quizzes: 1 });
  });

  test('exports subject, enrollment and QR totals as CSV', async () => {
    const now = new Date();
    await Subject.create({
      subjectCode: 'CS101',
      subjectName: 'Programming 1',
      section: 'BSIT-3A',
      program: 'BSIT',
      teacher: student._id,
      enrollmentCode: { token: 'CITE-CS101', createdAt: now, expiresAt: new Date(Date.now() + 86400000) },
      students: [
        { student: student._id, status: 'active', method: 'qr' },
        { student: adminUser._id, status: 'pending', method: 'code' },
      ],
    });
    await Subject.create({
      subjectCode: 'CS103',
      subjectName: 'Discrete Structures',
      section: 'BSIT-3B',
      program: 'BSIT',
      teacher: student._id,
      students: [{ student: student._id, status: 'active', method: 'code', blocked: true, blockReason: 'Dropped' }],
    });

    const res = await adminAgent.get('/api/admin/reports?type=subjects&format=csv').expect(200);

    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="subjects-report-\d+\.csv"/);

    const csv = res.text.replace(/^\uFEFF/, '');
    expect(csv).toContain('metric,value');
    expect(csv).toMatch(/^subjects,2$/m);
    expect(csv).toMatch(/^sections,2$/m);
    expect(csv).toMatch(/^roster_seats,3$/m);
    expect(csv).toMatch(/^active_enrollments,1$/m);
    expect(csv).toMatch(/^pending_enrollments,1$/m);
    expect(csv).toMatch(/^blocked_enrollments,1$/m);
    expect(csv).toMatch(/^unique_students,2$/m);
    expect(csv).toMatch(/^qr_codes_live,1$/m);
    expect(csv).toMatch(/^qr_codes_issued,1$/m);

    expect(csv).toContain('subject_code,subject_name,section,program,teacher,enrolled,active,pending,blocked,qr_status,qr_expires_at');
    expect(csv).toMatch(/^CS101,Programming 1,BSIT-3A,BSIT,Kim User,2,1,1,0,live,\d{4}-\d{2}-\d{2}T/m);
    expect(csv).toMatch(/^CS103,Discrete Structures,BSIT-3B,BSIT,Kim User,1,0,0,1,off,$/m);

    // CSV is only defined for the subjects report.
    await adminAgent.get('/api/admin/reports?type=users&format=csv').expect(422);
  });

  test('broadcast creates notifications for the selected role', async () => {
    const res = await adminAgent
      .post('/api/admin/notifications/broadcast')
      .send({ title: 'Maintenance', message: 'Sunday 02:00 UTC', role: 'student' })
      .expect(200);

    expect(res.body.data.sent).toBe(1);

    const feed = await studentAgent.get('/api/student/notifications').expect(200);
    expect(feed.body.data[0].title).toBe('Maintenance');
    expect(feed.body.meta.unread).toBe(1);
  });
});
