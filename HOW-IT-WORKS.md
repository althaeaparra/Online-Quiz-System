# HOW IT WORKS

A working explanation of CITE BrainCheck for whoever deploys, operates or extends
it. It describes the system as a deployed service — not the local demo shortcut —
so every statement here applies to a real MongoDB + Redis deployment.

Companion documents: `README.md` (project overview and commands) and `/api/docs`
(interactive OpenAPI reference generated from `docs/openapi.js`).

---

## 1. What the system is

One Express service that owns three things at once:

1. the **HTTP API** (`/api/...`),
2. the **single-page app** served from `public/` at `/` (hash routing, no build
   step),
3. the **Socket.IO endpoint** for live quiz sessions, mounted on the same HTTP
   server.

Three roles share that one origin, each with its own sign-in door:

| Portal | Route | Can do |
| --- | --- | --- |
| Student | `/#/student/login` | Join subjects by QR/code, take timed quizzes, review results, manage profile |
| Teacher | `/#/teacher/login` | Create subjects and QR codes, manage section rosters, author and publish quizzes, grade essays, read analytics |
| Admin | `/#/admin/login` | Everything above, plus user administration, categories, department analytics, reports, system health |

The admin door is not advertised: it is reachable by URL, and
`SHOW_ADMIN_LINK=true` adds a landing-page button for internal deployments. The
flag is served by `GET /api/config`, which exposes no secrets.

---

## 2. Runtime topology

```
browser ──HTTP/WS──> Express (app.js) ──> controllers ──> services ──> Mongoose ──> MongoDB
                          │                    │             │
                          │                    │             └──> Redis (cache, sessions, live sessions)
                          │                    └──> Socket.IO (sockets/realtime.js)
                          └──> static SPA from public/
```

* **MongoDB** — the only source of truth. Attempts, rosters, scores and grades
  are persisted there before anything is reported to the client.
* **Redis** — optional but expected in production. It holds the JWT session
  registry, rate-limit counters, attempt deadlines, cached analytics and the
  live-session store, and it powers the Socket.IO adapter that lets instances
  share rooms. Without it the same code runs against an in-process store with
  identical semantics but per-instance state.
* **Socket.IO** — never the authority for grading or persistence. It adds
  synchronised timers, presence, and a running leaderboard.

Every instance is stateless apart from that shared store, so horizontal scaling
is "run more copies behind a load balancer, all pointed at the same MongoDB and
Redis".

---

## 3. Boot sequence

`server.js` is the entry point for every environment:

1. **Configuration guard.** In production the process refuses to start when a
   JWT secret is missing, is still a `change-me…` placeholder, or is shorter than
   32 characters; when `MONGO_URI` is missing; or (development only) when no
   secret is set at all. Fatal configuration is logged once per problem and the
   process exits with status 1.
2. **Database.** `config/db.js` connects with `serverSelectionTimeoutMS: 4000`
   and `maxPoolSize` from `MONGO_POOL_SIZE` (default 20). In production an
   unreachable database is fatal. Automatic in-memory MongoDB exists only for
   development and tests.
3. **Redis.** `config/redis.js` connects when `REDIS_URL` is set and retries
   briefly; failure is logged and the app continues on the in-memory store.
4. **Socket.IO.** `initRealtime()` attaches to the HTTP server, using the Redis
   adapter when it is available so rooms span instances.
5. **Listen.** Defaults to port `5000` (`PORT`).
6. **Shutdown.** `SIGTERM`/`SIGINT` stop accepting connections, close the socket
   adapter, Redis and Mongo, and force-exit after 10 s if something hangs.

Startup warnings worth reading on a first deploy: `REDIS_URL is not set`,
`APP_URL is not set`, `COOKIE_SECURE=false`, and a missing `CORS_ORIGINS`.

---

## 4. Request pipeline

Order matters, and it is fixed in `app.js`:

```
helmet (CSP, HSTS, no sniff, frameguard)
  → CORS allowlist
  → compression
  → JSON / urlencoded body parsing (1 MB cap)
  → cookie parser
  → HTTP access log (morgan → winston; /health is skipped)
  → static /uploads and the SPA in public/
  → GET /health
  → /api  (global rate limit → route → zod validation → auth/RBAC → controller → service)
  → JSON 404 for unknown /api paths
  → SPA fallback for everything else
  → error handler
```

Two consequences worth knowing:

* **CORS is closed by default.** Requests with no `Origin` (curl, server-side
  calls) pass. A browser request is allowed when its origin's host matches the
  request host (the SPA case), when it appears in `CORS_ORIGINS`, `APP_URL` or
  `CLIENT_URL`, or — development only — when it is `localhost`. Anything else is
  answered without CORS headers, so the browser blocks it while the API still
  responds normally. There is no "allow all with credentials" mode.
* **`/api/*` never returns HTML.** Unknown API routes produce a JSON
  `ROUTE_NOT_FOUND`, so a typo in a client call cannot be mistaken for a page.

Every response uses one envelope:

```json
{ "success": true,  "data": {}, "meta": {} }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [] } }
```

Errors are `AppError` subclasses in `utils/errors.js`; the handler maps each to a
status (`401`, `403`, `404`, `409`, `422`, `429`, `500`) and logs the stack for
5xx only.

---

## 5. Data model

| Model | Purpose | Key fields and invariants |
| --- | --- | --- |
| `User` | Accounts for all three roles | `username`/`email` unique, bcrypt password, `role`, `profile`, `academic` (studentId + section + program, or teacherId + department), `preferences`, `stats` (streaks, averages), `security` (`isActive`, `emailVerified`, attempt counter, `lockUntil`, reset/verification tokens hidden from queries) |
| `Subject` | A class section that owns a roster | `subjectCode` unique per teacher **and** section, `section`, `program`, `teacher`, `enrollment` settings, `enrollmentCode` (`token`, `createdAt`, `expiresAt`, `rotatedAt`), `students[]` roster rows, `isArchived` |
| `Quiz` | Assessment definition | `title`, `category`, `teacher`, optional `subject`, embedded `questions[]` (type, options, correct answer, points, time limit), `settings` (timer, shuffling, attempts, passing score), `isPublished`, denormalised `analytics` counters |
| `Result` | One attempt | `quiz`, `student`, `teacher`, `answers[]` with per-question grading, `score` (max, total, percentage, passed), `attemptNumber`, `status` (`in_progress` → `submitted` → `graded`), `timeSpent`, timestamps, `gradedBy` |
| `Category` | Quiz grouping | `name`, `slug`, `color`, `icon`, optional parent, `quizCount` |
| `Notification` | In-app feed | `user`, `type`, `title`, `message`, `link`, `isRead`, per-channel sent flags; old records are pruned |

The roster row inside `Subject.students` is the enrollment record:

```js
{ student, enrolledAt, method: 'qr' | 'code', status: 'active' | 'pending',
  blocked: boolean, blockedAt, blockReason, blockedBy }
```

Indexes are declared on the models and applied by `npm run migrate` (see §12).
`autoIndex` is off in production, so a schema change ships with a migration
step, not a silent index build on first request.

---

## 6. Identity and access

### Tokens

* **Access token** — JWT, 15 minutes (`JWT_ACCESS_EXPIRES`), claims `sub`,
  `role`, `username`, `type: access`, issuer `citebraincheck`, audience
  `citebraincheck-client`.
* **Refresh token** — JWT, 7 days (`JWT_REFRESH_EXPIRES`), carries a `jti` that
  is registered in Redis under `sessions:<userId>` (a set with the refresh TTL).
* Both are sent as **httpOnly cookies** (`qf_access`, `qf_refresh`), so the SPA
  never touches a token. Flags: `HttpOnly`, `SameSite=Lax` (override with
  `COOKIE_SAME_SITE`), `Secure` in production unless `COOKIE_SECURE=false`,
  optional `COOKIE_DOMAIN`.
* Clients may also send `Authorization: Bearer <access>`; `extractAccessToken`
  checks the header first, then the cookie.

### Session lifecycle

1. **Login** (`POST /api/auth/login`) verifies the password, honours the
   portal's `expectedRole`, clears the failure counter, registers a refresh
   `jti` and sets both cookies.
2. **Refresh** (`POST /api/auth/refresh`) verifies the refresh token, checks the
   `jti` is still in the session set, then **rotates**: the old `jti` is revoked
   and a new pair is issued. Replaying a rotated token fails.
3. **Logout** revokes that `jti` and clears the cookies. The access token remains
   cryptographically valid until it expires — at most 15 minutes — which is the
   accepted trade-off for stateless access tokens; the refresh path is already
   dead, so a client cannot extend a session.
4. **Password change / reset** calls `revokeAllSessions`, which drops the whole
   session set: every other device must sign in again.
5. **Brute force** — five consecutive failures lock the account for 15 minutes
   (`security.lockUntil`); a successful login resets the counter.

### Authorisation

* `authenticate` resolves the user on every request (not just the token claims),
  so deactivation, locks and role changes take effect immediately.
* `authorize(...roles)` gates whole routers. **Admin implicitly passes every
  role gate.**
* `ownershipMiddleware` protects teacher resources (quizzes): the loaded
  document's `teacher` must equal the caller, unless the caller is an admin.
* Subject routes use `getOwnedSubject(...)`, which applies the same rule to
  subjects, including admins.
* Subject-linked content has a second gate: students must be on the roster, not
  blocked, and (if the subject requires approval) approved.

Rate limits sit in front of all of this: 300 requests / 15 min per user-or-IP on
the API, 20 / 15 min on authentication keyed by IP **and** identifier, 40 / min
on writes. Responses carry `RateLimit-*` headers and `429` with `Retry-After`.

---

## 7. Subjects, QR enrollment and blocking

A teacher creates a subject for **one section** (for example `CS101`,
`BSIT-3A`, `BSIT`). The subject is the enrollment boundary: quizzes can be
pinned to it, and only its members can see or start those quizzes.

### The code

`POST /api/teacher/subjects/:id/qr` mints a short code (`K7F2-QX9M`), stores it
with a creation time and an expiry (default 168 h, per subject
`enrollment.qrExpiresInHours`), renders a PNG QR of the join URL
`<APP_URL>/#/enroll/<code>`, and returns code, URL and data URL. Rotating
replaces the token and expiry; the previous code stops working immediately. A
unique index plus a collision check keep codes from repeating.

The raw token is stored on the document but **stripped from every JSON
serialisation**, so listing subjects never leaks a working join code.

### The join

`POST /api/student/enroll/preview` shows what the code points at; `POST
/api/student/enroll` commits. The service enforces, in order:

1. the code exists and has not expired,
2. `enrollment.isOpen` and `enrollment.allowQr` are true,
3. the student's `academic.section` matches the subject's section,
4. capacity (`enrollment.maxStudents`, default 50) is not exceeded,
5. the student is not blocked from this subject (blocked wins over everything —
   they cannot rejoin with a fresh code),
6. if `requireApproval` is set, the row lands as `pending` instead of `active`.

Re-joining an existing membership is idempotent and returns the existing row.

### Blocking

`POST /api/teacher/subjects/:id/students/:studentId/block` records the reason,
the blocking teacher and the timestamp, and keeps the roster row so history and
subject averages survive. From that moment the student cannot start subject
quizzes, the quizzes disappear from their catalogue, and they cannot rejoin.
`DELETE …/block` reverses it; `DELETE …/students/:studentId` removes the row
entirely (they may enrol again with a valid code).

---

## 8. Quiz lifecycle and grading

### Authoring

Teachers build quizzes in the SPA and `POST` them to
`/api/teacher/quizzes`; drafts are saved with `isPublished: false`. A quiz may
be pinned to a subject (ownership validated) and to a category. Settings:
time per question, total time limit, shuffle questions/options, show answers,
allow retakes, max attempts, passing score.

### Starting an attempt

`POST /api/student/quizzes/:id/start`:

1. loads a published quiz and, if it belongs to a subject, asserts membership;
2. returns an existing `in_progress` attempt if one exists (a refresh or a
   reconnect resumes instead of burning an attempt);
3. otherwise enforces `allowRetakes` and `maxAttempts`, creates the `Result`
   with one answer stub per question (question text, type, max points,
   `needsManualGrading` for essays), and assigns the next attempt number;
4. computes the deadline from `settings.totalTimeLimit` or the sum of the
   per-question limits, and caches it as `attempt:<resultId>` with a TTL of the
   limit plus five minutes;
5. returns the student view of the quiz — shuffled consistently for this attempt
   via a seed derived from the attempt id — with answers withheld according to
   `showCorrectAnswers`.

### Submitting

`POST /api/student/quizzes/:id/submit` sends only `{ questionId, answer }`
pairs. The server:

* grades against the stored quiz, never the client's claims;
* compares multiple-choice indices, true/false booleans, and short answers
  case-insensitively against the accepted answer list;
* marks essays `needsManualGrading` and scores them `0` for now;
* clamps `timeSpent` to the server-measured elapsed time, so a client cannot
  claim to have finished in four seconds;
* sets `status` to `submitted` when essays are pending, otherwise `graded`;
* recomputes `score` (`maxScore`, `totalScore`, `percentage`,
  `passed = percentage >= passingScore`), then refreshes the quiz's denormalised
  analytics and the student's aggregate stats (including streaks).

### Manual grading

`POST /api/teacher/results/:id/grade` takes per-question points and feedback for
essay answers. Points are clamped to each question's maximum; once no answer
needs grading the result flips to `graded`, with `gradedBy` and `gradedAt` set
and the same analytics refresh applied.

---

## 9. Live sessions (Socket.IO)

Optional but fully implemented. The HTTP API stays authoritative; the socket
layer adds synchronisation and spectacle.

**Authentication.** The handshake presents the access token (cookie, `auth.token`
or `query.token`); invalid tokens are rejected before any event is handled.

**State lives in `sockets/liveSessionStore.js`**, backed by Redis when
`REDIS_URL` is set (`citebraincheck:live:*` keys, 13 h TTL) and by memory
otherwise. Because the deadline, scores and lease are shared:

* a restarting instance resumes a running countdown instead of losing it;
* a student on instance B sees a leaderboard produced on instance A;
* exactly one instance drives the 1-second ticker for a session, because it must
  hold a 5-second lease that is renewed and fails over if the holder dies.

**Events.**

| Direction | Event | Meaning |
| --- | --- | --- |
| client → server | `quiz:join` | Join the quiz room; ack carries quiz summary, current timer (or `null`), leaderboard and participant count |
| client → server | `quiz:leave` | Leave the room and update presence |
| client → server | `quiz:start` | Host (quiz owner or admin) starts a synchronised session with a duration |
| client → server | `answer:submit` | Live scoring for instant feedback and leaderboard movement |
| client → server | `quiz:end` | Host ends the session early |
| server → room | `quiz:started` | Start time, end time, total and remaining seconds |
| server → room | `quiz:timer` | Countdown tick each second |
| server → room | `quiz:participants` | Live participant count and whether a session is running |
| server → room | `quiz:leaderboard` | Ranked standings after each scored answer |
| server → room | `quiz:ended` | `reason: 'time_up'` or `'host_ended'`, with the final leaderboard |

Leaderboard order is points descending, then answers submitted, then username.
`answer:submit` rewards live points but does **not** write a `Result`; the
student's attempt is still submitted over HTTP, so live play can never inflate a
recorded grade. Sessions cap at 12 hours.

---

## 10. Analytics and exports

Computed on demand with aggregation pipelines in `services/analyticsService.js`,
with denormalised counters (`Quiz.analytics`, `User.stats`) recomputed after
every submission and by the cleanup job:

* **Student** — score trend, per-category strengths and weaknesses, difficulty
  breakdown, streaks, time management, recent results.
* **Teacher** — per-quiz attempts/average/pass rate, engagement timeline, hardest
  questions (minimum sample size), students who never attempted, grading queue.
* **Admin dashboard** — users by role and signup growth, quiz and attempt
  totals, average score and pass rate, top categories and quizzes, and
  department-wide subject/enrollment/QR activity: subject and section counts,
  roster seats, active/pending/blocked seats, unique students, live vs issued QR
  codes, new joins in the window, and the largest subjects with teacher names.

**CSV exports** (server-generated, no client formatting):

* `GET /api/admin/reports?type=subjects&format=csv[&days=30]` — a `metric,value`
  block with the department totals, then one row per subject with section,
  program, teacher, enrolled/active/pending/blocked seats and QR state.
* `GET /api/teacher/subjects/:id/roster` — the section roster: name, student ID,
  section, status, block reason, enrollment timestamp.

Both include blocked students, sort deterministically, escape per RFC 4180 and
carry a UTF-8 BOM so spreadsheets open them cleanly. Other report types remain
available as JSON (`overview`, `users`, `quizzes`, `results`).

---

## 11. API map

| Prefix | Purpose | Auth |
| --- | --- | --- |
| `/api/auth` | register, login, refresh, logout, forgot/reset password, verify email, change password, `me` | public except `me`/`change-password` |
| `/api/student` | dashboard, subjects, enroll/preview, quizzes, start/submit, results, in-progress, stats, profile, avatar, notifications | any signed-in account (role-specific data) |
| `/api/teacher` | subjects + QR + roster + blocking, categories, quiz CRUD/publish/duplicate, analytics, students, results, grading, reminders, profile | teacher or admin |
| `/api/admin` | dashboard, users, categories, quizzes, feature flags, system health, reports (JSON/CSV), broadcasts | admin only |
| `/api` | public catalogue (quizzes, questions, categories, leaderboard, stats, client config) | public; result review needs the owner |
| `/api/docs` | Swagger UI + `openapi.json` | public |
| `/health` | liveness/readiness (503 when Mongo is not connected) | public |

Every endpoint with a body is validated by a Zod schema in
`utils/validators.js` through `middleware/validation.js`; failures return `422`
with per-field details.

---

## 12. Operations

| Task | Command | Notes |
| --- | --- | --- |
| Create the first admin | `npm run create-admin -- --email … --password … --name "…"` | Creates or promotes one account, activates it, resets the password. Never touches other data. Env alternative: `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_USERNAME`, `ADMIN_NAME`. |
| Apply schema changes | `npm run migrate` | `syncIndexes()` for every model plus backfills (academic profiles, category slugs, quiz defaults, category counts). Run once per deploy, before the new version takes traffic. |
| Housekeeping | `npm run cleanup` | Cron-friendly: removes abandoned attempts older than `CLEANUP_ABANDONED_HOURS` (24), prunes notifications older than 90 days, recomputes the busiest 200 quizzes and student stats, reports the cache driver. |
| Health | `GET /health` | `200` when Mongo is connected, `503` otherwise; includes uptime and environment. |
| Deep health | `GET /api/admin/system-health` | Process, memory, load, DB ping, cache driver, environment — admin only. |
| Logs | stdout + `LOG_DIR` (default `logs/`) | Winston JSON in production, morgan access lines, errors with stacks. |
| Demo data | `npm run seed` | **Blocked when `NODE_ENV=production`** unless `ALLOW_DEMO_SEED=true`. It wipes collections and installs demo accounts; never run it on a real deployment. |

**Backups.** MongoDB is the only durable state (plus the `uploads` volume for
avatars). Snapshot the database and the uploads volume together; Redis holds
sessions, counters and live-session state that can be rebuilt, so losing it
signs users out and drops in-flight live sessions but corrupts nothing.

**Scaling.** Add instances behind a load balancer with sticky sessions (or
WebSocket-capable routing) and the same `MONGO_URI` + `REDIS_URL`. Without Redis
each instance keeps its own sessions, rate-limit counters and live-session
state, so run exactly one.

---

## 13. Deploying

### Docker Compose (provided)

`docker-compose.yml` builds the API image, starts MongoDB 7 and Redis 7 with
health checks and named volumes, and waits for both before starting the API.

```bash
cp .env.example .env
# set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET (32+ random chars each)
docker compose up --build -d
docker compose exec api npm run migrate
docker compose exec api npm run create-admin -- --email head@cite.edu --password '…'
```

The container runs as a non-root user with `tini` as PID 1, declares a
`/health` health check, and serves on port `5000`. Compose serves plain HTTP on
localhost, so it sets `COOKIE_SECURE=false`; set `COOKIE_SECURE=true` in `.env`
once TLS terminates in front of it.

### Any Node host

```bash
npm ci --omit=dev
NODE_ENV=production \
MONGO_URI='mongodb+srv://…/citebraincheck' \
REDIS_URL='redis://…' \
JWT_ACCESS_SECRET='…' JWT_REFRESH_SECRET='…' \
APP_URL='https://braincheck.cite.edu' \
CORS_ORIGINS='https://braincheck.cite.edu' \
npm start
```

Then run `npm run migrate` and `npm run create-admin` once with the same
environment.

### Configuration reference

| Variable | Default | Why it matters |
| --- | --- | --- |
| `NODE_ENV` | `development` | Switches production guards, cookie defaults, logging format, index creation |
| `PORT` | `5000` | HTTP/WebSocket port |
| `APP_URL` | request host | Absolute links in QR join URLs and emails; also a CORS origin |
| `CLIENT_URL` | — | Extra CORS origin for a separately hosted front end |
| `CORS_ORIGINS` | — | Comma-separated allowlist; same-host requests are always allowed |
| `MONGO_URI` | — | Required in production; the process refuses to start without it |
| `MONGO_POOL_SIZE` | `20` | Connection pool per instance |
| `REDIS_URL` | — | Sessions, rate limits, attempt deadlines, live sessions, socket adapter |
| `REDIS_PREFIX` | `citebraincheck:` | Namespace for cache/session keys |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | dev fallback | Required, 32+ random chars, distinct values, in production |
| `JWT_ACCESS_EXPIRES` / `JWT_REFRESH_EXPIRES` | `15m` / `7d` | Token lifetimes |
| `BCRYPT_ROUNDS` | `12` | Password hashing cost |
| `COOKIE_SECURE` | `true` in production | `false` only for HTTP-only internal deployments |
| `COOKIE_SAME_SITE` | `lax` | `none` only for a cross-site front end, with Secure cookies |
| `COOKIE_DOMAIN` | unset | Set when the API shares a parent domain with the SPA |
| `SHOW_ADMIN_LINK` | `false` | Advertises the admin door on the landing page |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `900000` / `300` | Global API limiter |
| `AUTH_RATE_LIMIT_MAX` | `20` | Login/registration attempts per window |
| `SMTP_*`, `MAIL_FROM` | unset | Real email delivery; unset logs messages instead |
| `UPLOAD_DIR`, `MAX_UPLOAD_MB` | `public/uploads`, `2` | Avatar storage and cap |
| `LOG_LEVEL`, `LOG_DIR` | `info`, `logs` | Logging |
| `CLEANUP_ABANDONED_HOURS` | `24` | Cleanup job threshold |
| `ALLOW_DEMO_SEED` | `false` | Must be `true` to let `npm run seed` touch a production database |

---

## 14. Security model at a glance

* Passwords hashed with bcrypt (cost 12 by default); password hashes never
  leave the model layer, and `select: false` hides reset/verification tokens.
* Tokens live in httpOnly cookies; JavaScript cannot read them, so an XSS bug
  cannot exfiltrate a session token directly.
* Access tokens are short-lived; refresh tokens rotate and are revocable;
  password changes kill every session.
* RBAC is enforced server-side per router, plus ownership checks on every
  teacher resource and roster-level checks on subject content.
* Input validation with Zod on all write endpoints; unknown fields are rejected.
* Security headers via helmet (CSP, HSTS, no-sniff, frameguard, referrer
  policy), `x-powered-by` disabled.
* Rate limits on the API, on authentication, and on writes.
* CORS is an allowlist; no wildcard with credentials.
* Passwords, tokens and enrollment codes are stripped from API responses;
  the enrollment code is the one exception when a teacher explicitly generates
  or rotates it.
* Uploads are size- and type-limited and served from a dedicated path.

---

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| API exits immediately on boot | Missing/short/placeholder JWT secret, or missing `MONGO_URI` | Read the `Refusing to start:` lines; use 32+ random characters per secret |
| Sign-in succeeds but the browser immediately forgets it | Cookies marked `Secure` while served over HTTP, or `SameSite=None` without Secure | Set `COOKIE_SECURE=false` for HTTP, or serve over TLS and keep it true |
| Browser requests blocked with CORS errors | Origin not in the allowlist and not the API's own host | Add the exact origin to `CORS_ORIGINS` or set `APP_URL` |
| Everything is `429` | Global/auth/write limiter | Raise `RATE_LIMIT_MAX`, or use Redis so counters are shared and accurate |
| `/health` returns 503 | MongoDB not reachable | Check `MONGO_URI`, network rules, Atlas allowlist |
| Two instances show different live timers/leaderboards | No Redis, so state is per instance | Set `REDIS_URL`; the socket adapter and shared session store need it |
| `npm run seed` refuses to run | `NODE_ENV=production` | Use `npm run create-admin`; seeding demo data is blocked by design |
| QR join refused | Expired or rotated code, wrong section, full subject, closed enrollment, or the student is blocked | The API returns a specific message per case; teachers see the same state in Studio → Subjects |
| 422 on a request that "looks fine" | Zod validation, including unknown fields | Read `error.details[].field` |

---

## 16. Where to look in the code

| Path | Contents |
| --- | --- |
| `server.js`, `app.js` | Boot guards, middleware pipeline, health, SPA serving |
| `config/` | Mongo/Redis clients, shared constants and defaults |
| `models/` | Schemas, indexes, password hashing, result recalculation, subject roster helpers |
| `middleware/` | Authentication/RBAC/ownership, Zod validation, rate limits, uploads, error handling |
| `controllers/` | HTTP shape per area: auth, student, teacher, admin, quiz, subject, public |
| `services/` | Business rules: quiz start/submit/grade, subject enrollment/QR/blocking, analytics, email, notifications |
| `sockets/` | Live session protocol (`realtime.js`), durable session store (`liveSessionStore.js`), Redis adapter |
| `routes/` | URL map and role gates per area |
| `utils/` | JWT/cookie helpers, cache facade, CSV/format helpers, validators, response envelope, logger |
| `public/` | The SPA: hash router, views per role, API client |
| `scripts/` | `migrate`, `create-admin`, `cleanup`, `seed` (development only) |
| `tests/` | Jest + Supertest: auth, subjects/QR, quiz flow, admin, realtime, grading, helpers |

---

## 17. Development-only conveniences

These exist for local work and are deliberately inert in production: the
in-memory MongoDB fallback, `npm run dev:demo` seeding on boot, permissive
`localhost` CORS, non-Secure cookies in development, and the JSON transport that
logs emails instead of sending them. Production refuses the memory database,
blocks demo seeding, and requires real secrets, a real database and configured
origins.
