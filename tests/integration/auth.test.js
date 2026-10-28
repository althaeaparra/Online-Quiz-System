import request from 'supertest';
import app from '../../app.js';
import { setupTestDb, clearTestDb, teardownTestDb, seedUser } from '../helpers/db.js';

const creds = {
  username: 'newstudent',
  email: 'newstudent@test.dev',
  password: 'Password123',
  role: 'student',
  profile: { firstName: 'New', lastName: 'Student' },
  academic: { studentId: '2026-09999', section: 'BSIT-3A', program: 'BSIT', yearLevel: '3rd year' },
};

beforeAll(async () => {
  await setupTestDb();
}, 120000);

afterEach(async () => {
  await clearTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

const cookieValue = (res, name) => {
  const raw = res.headers['set-cookie'] || [];
  const found = raw.find((c) => c.startsWith(`${name}=`));
  return found ? decodeURIComponent(found.split(';')[0].split('=')[1]) : null;
};

describe('POST /api/auth/register', () => {
  test('creates an account, sets cookies and never returns the password', async () => {
    const res = await request(app).post('/api/auth/register').send(creds).expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({ username: creds.username, email: creds.email, role: 'student' });
    expect(res.body.data.user.password).toBeUndefined();
    expect(res.body.data.accessToken).toBeTruthy();
    expect(cookieValue(res, 'qf_access')).toBeTruthy();
    expect(cookieValue(res, 'qf_refresh')).toBeTruthy();
  });

  test('rejects duplicate emails', async () => {
    await request(app).post('/api/auth/register').send(creds).expect(201);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...creds, username: 'different' })
      .expect(409);

    expect(res.body.error.code).toBe('CONFLICT');
  });

  test('rejects weak passwords with field-level details', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...creds, password: 'weak' })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.some((d) => d.field === 'password')).toBe(true);
  });
});

describe('login & session lifecycle', () => {
  test('signs in, reads /me and signs out', async () => {
    await seedUser({ username: 'alice', email: 'alice@test.dev' });
    const agent = request.agent(app);

    const login = await agent
      .post('/api/auth/login')
      .send({ identifier: 'alice@test.dev', password: 'Password123' })
      .expect(200);

    expect(login.body.data.user.username).toBe('alice');

    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.data.email).toBe('alice@test.dev');

    await agent.post('/api/auth/logout').send({}).expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  test('accepts a username identifier too', async () => {
    await seedUser({ username: 'bob', email: 'bob@test.dev' });
    await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'bob', password: 'Password123' })
      .expect(200);
  });

  test('locks the account after five failed attempts', async () => {
    await seedUser({ username: 'carol', email: 'carol@test.dev' });

    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/auth/login')
        .send({ identifier: 'carol@test.dev', password: 'WrongPassword1' })
        .expect(401);
    }

    const locked = await request(app)
      .post('/api/auth/login')
      .send({ identifier: 'carol@test.dev', password: 'Password123' })
      .expect(403);

    expect(locked.body.error.message).toMatch(/Too many failed attempts/i);
  });

  test('rotates refresh tokens and invalidates the previous one', async () => {
    await seedUser({ username: 'dave', email: 'dave@test.dev' });
    const agent = request.agent(app);

    const login = await agent
      .post('/api/auth/login')
      .send({ identifier: 'dave@test.dev', password: 'Password123' })
      .expect(200);

    const originalRefresh = cookieValue(login, 'qf_refresh');
    expect(originalRefresh).toBeTruthy();

    const refreshed = await agent.post('/api/auth/refresh').send({}).expect(200);
    expect(refreshed.body.data.accessToken).toBeTruthy();

    // Replaying the rotated (revoked) token must fail.
    await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `qf_refresh=${originalRefresh}`)
      .send({})
      .expect(401);
  });

  test('refresh without a token is rejected', async () => {
    await request(app).post('/api/auth/refresh').send({}).expect(401);
  });
});

describe('password reset & email verification', () => {
  test('forgot-password responds generically for unknown emails', async () => {
    const res = await request(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'ghost@test.dev' })
      .expect(200);

    expect(res.body.data.message).toMatch(/If an account exists/i);
  });

  test('reset-password rejects an invalid token', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'a'.repeat(64), password: 'NewPassword123' })
      .expect(422);

    expect(res.body.error.message).toMatch(/invalid or has expired/i);
  });

  test('verify-email rejects an invalid token', async () => {
    await request(app)
      .post('/api/auth/verify-email')
      .send({ token: 'b'.repeat(64) })
      .expect(422);
  });
});

describe('protected routes', () => {
  test('anonymous requests are rejected', async () => {
    const res = await request(app).get('/api/student/dashboard').expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('unknown API routes return JSON 404', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('cross-origin policy', () => {
  test('allows local tooling but never reflects an unknown origin', async () => {
    const local = await request(app).get('/api/config').set('Origin', 'http://localhost:5173').expect(200);
    expect(local.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const foreign = await request(app).get('/api/config').set('Origin', 'https://evil.example').expect(200);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('client config', () => {
  afterEach(() => {
    delete process.env.SHOW_ADMIN_LINK;
  });

  test('hides the admin portal by default', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.data).toEqual({ appName: 'CITE BrainCheck', showAdminPortal: false });
  });

  test('shows the admin portal when SHOW_ADMIN_LINK=true', async () => {
    process.env.SHOW_ADMIN_LINK = 'true';
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.data.showAdminPortal).toBe(true);
  });
});
