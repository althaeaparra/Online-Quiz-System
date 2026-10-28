# CITE BrainCheck — Online Quiz System

The CITE department's assessment platform: Express + MongoDB + Redis +
Socket.IO on the back, and a modern single-page UI on the front. Students join
a subject by scanning their teacher's QR code, sit timed assessments, and see
their standing. Teachers build subjects and quizzes, manage the section roster
and block a student when they must. Admins run the department.

![Stack](https://img.shields.io/badge/stack-Express%20·%20MongoDB%20·%20Redis%20·%20Socket.IO-f97316)

## Quick start

```bash
npm install
cp .env.example .env        # adjust secrets
npm run seed                # optional: demo users, categories and quizzes
npm run dev                 # http://localhost:5000
```

Want a populated app with **no** MongoDB or Redis at all? One command starts an
in-memory database and seeds the demo cohort:

```bash
npm run dev:demo            # http://localhost:5000
```


No MongoDB or Redis installed? Development falls back automatically:

* **Database** — if `MONGO_URI` is unreachable, an ephemeral **in-memory MongoDB**
  is started (data is lost on restart). Force it with `USE_MEMORY_DB=true`.
* **Cache** — with no `REDIS_URL`, sessions, attempts and rate-limit counters use
  an in-process store. Production should always set `REDIS_URL`.

Demo accounts created by `npm run seed` (password `Password123`):

| Role | Email | What to look at |
| --- | --- | --- |
| Student | `student@cite.edu` | My subjects, QR enrollment, streaks, results |
| Teacher | `teacher@cite.edu` | Subjects + QR codes, roster, builder, analytics |
| Teacher 2 | `professor@cite.edu` | A separate faculty account (CS103, BSIT-3B) |
| Student 2 | `student3@cite.edu` | BSIT-3B account, used to show section gating |
| Admin | `admin@cite.edu` | Users, categories, reports, system health |

Usage: sign in through the **student**, **teacher** or **admin** portal on the
landing page (they are separate doors — a student account is refused by the
teacher portal). Demo subjects ship with deterministic codes: **`CITE-CS101`**
(Programming 1, BSIT-3A), **`CITE-IT201`** (Information Management, BSIT-3A) and
**`CITE-CS103`** (Discrete Structures, BSIT-3B). Open `#/subjects` and join with
the code, or have a teacher press *QR code* in Studio → Subjects.

Open the app at `/`, the API reference at **`/api/docs`**, and the live health
probe at **`/health`**.

The admin portal is **hidden by default**. Sign in at `/#/admin/login` directly,
or set `SHOW_ADMIN_LINK=true` to show an **Admin** button on the landing page
(intended for internal deployments only). The flag is served publicly by
`GET /api/config`, which contains no secrets.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Production server |
| `npm run dev` | Watch-mode server |
| `npm run dev:demo` | In-memory DB + demo data (zero setup) |
| `npm run seed` | Demo cohort (`-- --keep` to avoid wiping) — refused when `NODE_ENV=production` |
| `npm run create-admin` | Create or promote the first administrator on a real deployment |
| `npm run migrate` | Sync indexes and backfill older documents |
| `npm run cleanup` | Cron-friendly housekeeping (abandoned attempts, staleness) |
| `npm test` | Jest + Supertest suite (uses in-memory MongoDB) |
| `npm run test:coverage` | Same, with coverage report |

A deployment-oriented explanation of the runtime, auth, enrollment, grading
and live-session internals lives in **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)**.

## Architecture

```
online-quiz-system/
├── app.js                  # Express app (security, static, routes, errors)
├── server.js               # HTTP server, Socket.IO, graceful shutdown
├── config/                 # db, redis, constants
├── models/                 # User (+ academic), Subject, Quiz, Result, Category, Notification
├── middleware/             # auth/RBAC, zod validation, rate limits, uploads, error handler
├── controllers/            # auth, student, teacher, admin, quiz, subject, public
├── services/               # grading, analytics, subjects/QR/blocking, email, notifications
├── sockets/                # realtime: timers, presence, leaderboard, shared session store
├── routes/                 # /api/auth, /api/student, /api/teacher, /api/admin, /api (public), /docs
├── utils/                  # tokens, cache, helpers, validators, response envelope, logger
├── public/                 # SPA (index.html + assets/css + assets/js)
├── scripts/                # seed, migrate, cleanup
└── tests/                  # unit + integration (supertest)
```

Requests flow `route → validation → auth/RBAC → controller → service → model`,
and every response uses one envelope:

```json
{ "success": true,  "data": { }, "meta": { } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] } }
```

## API surface

| Area | Highlights |
| --- | --- |
| **Auth** | role-scoped register/login (`expectedRole`), rotating refresh, logout, forgot/reset password, email verification, change password |
| **Public** | `GET /api/quizzes`, `/api/quizzes/:id/questions`, `/api/categories`, `/api/leaderboard`, `/api/stats` |
| **Student** | dashboard, `GET /subjects`, `POST /enroll`, `POST /enroll/preview`, `POST /quizzes/:id/start`, `POST /quizzes/:id/submit`, results, stats, profile, avatar, notifications |
| **Teacher** | subjects, `POST /subjects/:id/qr`, block/unblock/remove students, custom categories, quiz CRUD, publish/duplicate, analytics, students, results, grading queue, reminders |
| **Admin** | dashboard, users CRUD, categories CRUD, quizzes, feature toggles, system health, reports, broadcast |

Full interactive reference: **`/api/docs`** (rendered from `/api/docs/openapi.json`).

## Subjects, QR enrollment and blocking

* **Separate portals.** Registration captures a student ID + section or a
teacher ID + department. The login endpoint takes the portal's `expectedRole`, so
an account from the other portal is refused with a clear message.
* **QR enrollment.** A teacher creates a subject for one section. `POST
/api/teacher/subjects/:id/qr` mints a short code (`K7F2-QX9M`) plus a PNG QR of
`/#/enroll/<code>`. Rotating the code invalidates the previous one immediately.
* **Section-checked joins.** The student's `academic.section` must match the
subject's section; capacity, expiry and `enrollment.isOpen` are enforced
server-side, and `requireApproval` leaves the student pending until the teacher
reviews them.
* **Roster export.** `GET /api/teacher/subjects/:id/roster` returns the section
  roster as a CSV attachment — name, student ID, section, status, block reason
  and enrollment date, blocked students included. The *Export CSV* button beside
  the roster in Studio → Subjects downloads the same file.
* **Subject-gated quizzes.** A quiz with a `subject` is hidden from non-members
in `/api/student/quizzes` and refuses `start` for non-members, pending students
and blocked students. The public catalogue may still list it; opening it requires
membership.
* **Blocking.** Blocking keeps the student's results and roster row but revokes
access to every subject quiz and prevents re-joining with a fresh code. A reason
is stored and shown to the student. Removing the row frees their seat.
* **Custom categories.** Teachers can add a category from the quiz builder; names
are deduplicated and return the existing category when reused.

## Security model

* **Tokens** — 15-minute access JWT + 7-day refresh JWT, both delivered as
  `httpOnly`, `SameSite` cookies; the SPA never sees them. Refresh rotates the
  token id (`jti`) and revokes the previous one (Redis-backed session registry),
  so a stolen refresh token is single-use.
* **Passwords** — bcrypt (12 rounds), never selected by default, 5 failed logins
  locks the account for 15 minutes.
* **RBAC** — `authenticate` → `roleMiddleware` → `ownershipMiddleware`; admins
  bypass ownership but never role checks implicitly.
* **Validation** — every body/query parsed with Zod; unknown keys are stripped.
* **Rate limits** — global API, auth (per IP + identifier), and write limits,
  all Redis-counted with in-memory fallback.
* **Headers** — Helmet with a CSP that allows only self + the inline docs page,
  CORS allowlist, `trust proxy`, compression, 1 MB body cap, Multer uploads
  restricted by MIME + extension + size.

## Realtime

Socket.IO authenticates with the same access cookie/JWT, then:

| Event | Direction | Purpose |
| --- | --- | --- |
| `quiz:join` / `quiz:leave` | client → server | room membership + presence |
| `quiz:participants` | server → room | live participant counter |
| `quiz:start` (host) | client → server | begins a synchronised session |
| `quiz:timer` | server → room | authoritative remaining seconds |
| `answer:submit` | client → server | instant correctness feedback + live leaderboard |
| `quiz:leaderboard` / `quiz:ended` | server → room | standings and session close |

Grading and persistence always happen over HTTP — the socket layer only adds
speed and presence, so a dropped connection cannot corrupt a score.

**Shared across instances.** Live state — the deadline, the standings and the
registry of running sessions — lives in [`sockets/liveSessionStore.js`](sockets/liveSessionStore.js):
Redis when `REDIS_URL` is set, an in-process store otherwise. A short ticker
lease (`SET NX EX`) elects one instance to emit the countdown, so a second node
never double-broadcasts and a restarted node resumes a session that is still
running instead of losing the timer. When Redis is reachable,
`@socket.io/redis-adapter` forwards room emits and cross-node presence through
pub/sub, so a student on one instance sees a leaderboard produced on another.
Without Redis the same code serves a single process.

## Analytics

* **Student** — score trend, per-category strengths, difficulty breakdown,
  streaks, time management.
* **Teacher** — attempt volume, pass rate, score distribution, engagement
  timeline, per-question correct rate, students who never attempted.
* **Admin** — role counts, signup growth, quiz/attempt totals, top categories,
  department subject/enrollment/QR activity (subjects, sections, active and
  expired codes, seats, pending and blocked students, largest subjects),
  exports (`/api/admin/reports?type=…&download=true`), uptime and memory health.

`GET /api/admin/reports?type=subjects&format=csv` returns the department
subject/enrollment/QR totals as a CSV attachment: a `metric,value` block with
the department numbers, then one row per subject with code, name, section,
program, teacher, enrolled/active/pending/blocked seats, QR status and expiry.
The *Export CSV* button in the admin dashboard's **Subjects & enrollment**
section downloads exactly that file. `days` (1–365, default 30) sets the
window that QR issuance and new joins are counted over.

## Deployment

```bash
docker compose up --build      # api + mongo + redis
```

CI (`.github/workflows/ci.yml`) runs the test suite on every push and builds the
production image; pushes to `main` also publish it to GitHub Container Registry
as `ghcr.io/<owner>/<repo>:latest` and `:sha-<commit>`.

### Continuous deployment

With repository secrets in place, a green `main` build also rolls out to a server
over SSH:

| Secret | Purpose |
| --- | --- |
| `DEPLOY_HOST` | Server address. Without it the deploy job reports and skips, so main never goes red for an unconfigured repo |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_SSH_KEY` | Private key whose public half is in that user's `authorized_keys` |
| `DEPLOY_PATH` | Directory on the server holding this repo's `docker-compose.yml` and its `.env` |
| `DEPLOY_PORT` | Optional SSH port, default 22 |

The job exports `IMAGE_TAG=sha-<commit>`, pulls that tag for the `api` service,
runs `npm run migrate` inside it, restarts the service with `--no-build`, then
polls `/health` for a minute and prints container logs if it never turns
healthy. The server keeps its own `.env`; the workflow only supplies the image
tag, never the secrets.

#### Rolling back

`.github/workflows/rollback.yml` is manual — run **Rollback** from the Actions
tab and fill in why. Leave the tag blank and CI walks the branch's commits,
keeping those that actually have a published `sha-<commit>` image, then deploys
the one before the current build; or name a tag such as `sha-<commit>` directly.

It shares the deploy concurrency lock, skips migrations (they are forward-only,
so the previous image runs against the schema it already expects), waits on
`/health`, and records the tag, actor and reason in the run summary. `latest` is
not moved, so the next green `main` deploy returns the service to the newest
image.

Multi-stage `Dockerfile` (non-root, tini init, healthcheck). Set
`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — production refuses to boot with
missing, placeholder or short (<32 char) secrets, and refuses to boot without a
reachable `MONGO_URI`. Then apply the schema once with `npm run migrate` and
bootstrap the first administrator with `npm run create-admin`; demo seeding is
blocked in production. `COOKIE_SECURE` defaults to `true` there — set it to
`false` only for an HTTP-only internal deployment.

Behind a load balancer, run the app stateless with Redis shared: auth sessions,
rate limits and live quiz state all stay global, and Socket.IO attaches its
Redis adapter automatically so room broadcasts reach clients on every instance.
Keep the Socket.IO endpoint on the same origin as the app. CORS is an allowlist
(`CORS_ORIGINS`/`APP_URL`/`CLIENT_URL`, plus same-host requests) rather than an
open policy, so a browser calls the API from a configured origin only.

Full runtime, configuration and troubleshooting reference:
**[HOW-IT-WORKS.md](HOW-IT-WORKS.md)**.

## Testing

`npm test` boots an in-memory MongoDB, then exercises the real HTTP surface with
Supertest: grading rules, auth flows (including refresh rotation and lockout),
teacher authoring, attempt limits, RBAC denials, admin operations, role-scoped
login, QR enrollment (rotation, expiry, capacity, section mismatch, approval),
subject-gated quizzes and student blocking
([`tests/integration/subjects.test.js`](tests/integration/subjects.test.js)).

[`tests/integration/realtime.test.js`](tests/integration/realtime.test.js) starts a
real HTTP server and connects **two authenticated Socket.IO clients** (teacher host
and student) to verify the shared countdown stays in sync, live answer feedback
updates the leaderboard for everyone, and only the host can end a session — plus
rejection of unauthenticated sockets.

[`tests/integration/liveSessions.test.js`](tests/integration/liveSessions.test.js)
runs **two HTTP + Socket.IO servers over one session store**: a session started on
the first server is resumed after that server stops (same deadline, same standings,
ticker running again), and on a second concurrently-running server a student sees
the deadline, adds to the leaderboard and joins the end of the session. The store's
lease election is unit-tested for both backends in
[`tests/unit/liveSessionStore.test.js`](tests/unit/liveSessionStore.test.js).
