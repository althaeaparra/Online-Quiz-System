/* ─────────────────────────────────────────────────────────────────────────
   CITE BrainCheck SPA
   Hash router + tiny render helpers on top of the REST API.
   Auth lives in httpOnly cookies; the client never stores tokens.
   ───────────────────────────────────────────────────────────────────────── */

const app = document.getElementById('app');
const toasts = document.getElementById('toasts');
const modalRoot = document.getElementById('modal-root');

const state = {
  user: null,
  config: null,
  categories: null,
  route: { name: '/', params: {} },
  timer: null,
  runner: null,
  lastResult: null,
  socket: null,
  notifOpen: false,
};

/* ── utilities ──────────────────────────────────────────────────────────── */

const esc = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const money = (n) => Number(n || 0).toLocaleString();
const pct = (n) => `${Math.round(Number(n) || 0)}%`;

function secondsToClock(total = 0) {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function timeAgo(date) {
  if (!date) return '—';
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

const initials = (name = '') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'Q';

const expiryLabel = (date) => {
  if (!date) return '';
  const when = new Date(date);
  return when.getTime() <= Date.now() ? 'code expired' : `expires ${when.toLocaleDateString()}`;
};

const difficultyBadge = (d) => {
  const map = { easy: 'badge-success', medium: 'badge-warn', hard: 'badge-danger' };
  return `<span class="badge ${map[d] || 'badge-muted'}">${esc(d || 'medium')}</span>`;
};

/* ── toasts & modal ─────────────────────────────────────────────────────── */

function toast(message, { type = 'info', title } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div><strong>${esc(title || (type === 'error' ? 'Something went wrong' : 'Done'))}</strong><span>${esc(message)}</span></div>`;
  toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    setTimeout(() => el.remove(), 240);
  }, 4200);
}

function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-close="1">
        <div class="card modal" role="dialog" aria-modal="true">
          <h3>${esc(title)}</h3>
          <p>${esc(message)}</p>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-modal="cancel">Cancel</button>
            <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal="ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;

    const finish = (value) => {
      modalRoot.innerHTML = '';
      resolve(value);
    };
    modalRoot.querySelectorAll('[data-modal]').forEach((btn) =>
      btn.addEventListener('click', () => finish(btn.dataset.modal === 'ok')),
    );
    modalRoot.querySelector('.modal-backdrop').addEventListener('click', (event) => {
      if (event.target.dataset.close) finish(false);
    });
  });
}

/* ── API client ─────────────────────────────────────────────────────────── */

class ApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function rawRequest(path, { method = 'GET', body, keepalive } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    keepalive,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(payload?.error?.message || `Request failed (${res.status})`, {
      status: res.status,
      code: payload?.error?.code,
      details: payload?.error?.details,
    });
  }
  return payload;
}

let refreshInFlight = null;

async function api(path, options = {}) {
  try {
    return await rawRequest(path, options);
  } catch (err) {
    const isAuthCall = path.startsWith('/auth/login') || path.startsWith('/auth/refresh') || path.startsWith('/auth/register');
    if (err.status === 401 && !isAuthCall && !options._retried) {
      refreshInFlight ||= rawRequest('/auth/refresh', { method: 'POST', body: {} })
        .catch(() => null)
        .finally(() => {
          refreshInFlight = null;
        });
      const refreshed = await refreshInFlight;
      if (refreshed) {
        state.user = refreshed.data.user;
        return api(path, { ...options, _retried: true });
      }
    }
    throw err;
  }
}

/* ── layout ─────────────────────────────────────────────────────────────── */

const NAV_ITEMS = [
  { href: '#/quizzes', label: 'Explore', icon: '◈', roles: ['student', 'teacher', 'admin', 'guest'] },
  { href: '#/subjects', label: 'My subjects', icon: '▤', roles: ['student'] },
  { href: '#/dashboard', label: 'Dashboard', icon: '◉', roles: ['student', 'teacher', 'admin'] },
  { href: '#/studio/subjects', label: 'Subjects', icon: '▤', roles: ['teacher', 'admin'] },
  { href: '#/studio', label: 'Studio', icon: '✦', roles: ['teacher', 'admin'] },
  { href: '#/admin', label: 'Admin', icon: '⚙', roles: ['admin'] },
];

function layout(content, { active = '', wide = false } = {}) {
  const user = state.user;
  const role = user?.role || 'guest';
  const items = NAV_ITEMS.filter((item) => item.roles.includes(role) || item.roles.includes('guest'));

  const nav = items
    .map(
      (item) =>
        `<a class="nav-link ${active === item.href ? 'active' : ''}" href="${item.href}">${esc(item.label)}</a>`,
    )
    .join('');

  const mobileNav = items
    .map(
      (item) =>
        `<a href="${item.href}" class="${active === item.href ? 'active' : ''}"><span class="ico">${item.icon}</span>${esc(item.label)}</a>`,
    )
    .join('');

  const userArea = user
    ? `<div class="menu">
         <button class="avatar" data-action="toggle-menu" aria-label="Account menu">${
           user.profile?.avatar
             ? `<img src="${esc(user.profile.avatar)}" alt="" />`
             : esc(initials(user.profile?.firstName || user.username))
         }</button>
         <div class="dropdown" id="user-menu">
           <div class="dropdown-head">
             <strong>${esc(user.profile?.firstName || user.username)}</strong>
             <span>${esc(user.email)} · ${esc(user.role)}</span>
           </div>
           <a href="#/profile">Profile &amp; settings</a>
           <a href="#/results">My results</a>
           <a href="/api/docs" target="_blank" rel="noopener">API reference</a>
           <button class="danger" data-action="logout">Sign out</button>
         </div>
       </div>`
    : `<a class="btn btn-ghost btn-sm" href="#/login">Sign in</a>
       <a class="btn btn-primary btn-sm" href="#/register">Get started</a>`;

  return `
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="#/"><span class="logo">B</span> CITE BrainCheck <em>CITE department</em></a>
        <nav class="nav-links">${nav}</nav>
        <div class="nav-actions">
          ${user ? `<button class="btn-icon" data-action="notifications" aria-label="Notifications">🔔</button>` : ''}
          ${userArea}
        </div>
      </header>
      <main class="${wide ? 'page' : 'page'}">${content}</main>
      <nav class="mobile-nav">${mobileNav}${user ? `<a href="#/profile" class="${active === '#/profile' ? 'active' : ''}"><span class="ico">☺</span>You</a>` : `<a href="#/login"><span class="ico">→</span>Sign in</a>`}</nav>
    </div>`;
}

const loadingBlock = (count = 3) =>
  `<div class="skeleton-grid">${Array.from({ length: count }, () => '<div class="skeleton"></div>').join('')}</div>`;

/* ── views: landing ─────────────────────────────────────────────────────── */

async function viewLanding() {
  const [stats, featured] = await Promise.all([
    api('/stats').catch(() => ({ data: {} })),
    api('/quizzes?limit=3&sort=popular').catch(() => ({ data: [] })),
  ]);
  const s = stats.data || {};

  const cards = (featured.data || [])
    .map((quiz) => quizCard(quiz))
    .join('');

  return layout(
    `<section class="hero">
      <div class="hero-inner">
        <div>
          <span class="eyebrow">CITE Department · QR enrollment · live assessments</span>
          <h1>The CITE department's<br /><span class="gradient-text">brain check.</span></h1>
          <p class="lede">Students scan one QR code to join a subject. Teachers build the quiz, see the roster and grade the class. Every attempt is timestamped, section-checked and scored server-side.</p>
          <div class="hero-actions">
            <a class="btn btn-primary" href="${state.user ? '#/dashboard' : '#/student/login'}">${state.user ? 'Go to dashboard' : 'Student sign in'} →</a>
            <a class="btn btn-outline" href="${state.user?.role === 'teacher' ? '#/studio' : '#/teacher/login'}">Teacher portal</a>
            ${state.config?.showAdminPortal ? '<a class="btn btn-ghost" href="#/admin/login">Admin</a>' : ''}
          </div>
          <div class="hero-stats">
            <div class="hero-stat"><strong>${money(s.students)}</strong><span>CITE students</span></div>
            <div class="hero-stat"><strong>${money(s.teachers)}</strong><span>Faculty</span></div>
            <div class="hero-stat"><strong>${money(s.quizzes)}</strong><span>Live quizzes</span></div>
            <div class="hero-stat"><strong>${money(s.attempts)}</strong><span>Attempts graded</span></div>
          </div>

        </div>
        <aside class="hero-panel">
          <div class="mini-quiz">
            <div class="row">
              <span class="badge badge-soft">BSIT-3A · CS101</span>
              <span class="hint">Live · 1 of 5</span>
            </div>
            <h3 style="margin-top:6px">Which keyword creates a block-scoped binding?</h3>
            <div class="mini-option"><span class="key">A</span> var</div>
            <div class="mini-option picked"><span class="key">B</span> let <span style="margin-left:auto">✓</span></div>
            <div class="mini-option"><span class="key">C</span> function</div>
            <div class="row" style="margin-top:4px">
              <span class="hint">⚡ +10 points</span>
              <span class="badge badge-success">Correct</span>
            </div>
            <div class="row" style="border-top:1px solid var(--border);padding-top:12px;margin-top:6px">
              <span class="hint">◉ 28 enrolled · 12 online</span>
              <span class="badge badge-soft">Room CS101-3A</span>
            </div>
          </div>
        </aside>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Enroll in seconds</h2><a href="#/student/login">Student portal →</a></div>
      <div class="stat-grid">
        <div class="card"><span class="eyebrow">Step 1 · Teacher</span><h3>Generate a subject QR</h3><p class="hint" style="margin-top:8px">Pick the subject code and section. CITE BrainCheck mints a single enrollment code you can project or print.</p></div>
        <div class="card"><span class="eyebrow">Step 2 · Student</span><h3>Scan to join</h3><p class="hint" style="margin-top:8px">Open the student portal, scan the code (or type the short code) and you are added to the section roster instantly.</p></div>
        <div class="card"><span class="eyebrow">Step 3 · Class</span><h3>Take the assessment</h3><p class="hint" style="margin-top:8px">Only enrolled, unblocked students in that section can open the quiz. Scores land in the gradebook immediately.</p></div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Popular right now</h2>
        <a href="#/quizzes">View all →</a>
      </div>
      ${cards || `<div class="empty"><strong>No quizzes published yet</strong><span>Sign in as a teacher to create the first one.</span></div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>Built for every side of the classroom</h2></div>
      <div class="stat-grid">
        <div class="card card-hover"><span class="eyebrow">Students</span><h3>Practice with feedback</h3><p class="hint" style="margin-top:8px">Instant scoring, answer explanations, streaks and a personal analytics view that shows exactly where to improve.</p></div>
        <div class="card card-hover"><span class="eyebrow">Teachers</span><h3>Author &amp; understand</h3><p class="hint" style="margin-top:8px">Build quizzes with four question types, publish instantly, grade essays and see per-question difficulty across the class.</p></div>
        <div class="card card-hover"><span class="eyebrow">Admins</span><h3>Operate with confidence</h3><p class="hint" style="margin-top:8px">User and category management, platform analytics, reports and live system health — all behind one role gate.</p></div>
      </div>
    </section>`,
    { active: '' },
  );
}

/* ── views: auth ────────────────────────────────────────────────────────── */

const PORTALS = {
  student: {
    label: 'Student',
    slug: 'student',
    eyebrow: 'CITE student portal',
    title: 'Your class,<br />checked in.',
    blurb: 'Scan your teacher\'s QR code to join a subject, sit timed assessments and see exactly where to improve.',
    points: [
      ['QR subject enrollment', 'Point your camera at the code your teacher projects — you\'re in the right section instantly.'],
      ['One attempt, honest scores', 'Subject assessments lock after you submit, so every grade reflects the same conditions.'],
      ['Instant feedback', 'Scores, correct answers and per-topic strengths the moment you submit.'],
    ],
    headings: { login: 'Student sign in', register: 'Create your student account' },
    captions: {
      login: 'Use your university email or username to open your subjects.',
      register: 'Your student ID and section route you to the right quizzes.',
    },
  },
  teacher: {
    label: 'Teacher',
    slug: 'teacher',
    eyebrow: 'CITE faculty portal',
    title: 'Teach the class.<br />See the data.',
    blurb: 'Create subjects, hand out QR codes, build quizzes and watch the roster\'s progress in real time.',
    points: [
      ['QR enrollment per subject', 'One code per subject and section — no manual class lists.'],
      ['Roster control', 'Block a student from a subject in one click, with a reason on record.'],
      ['Section analytics', 'Per-question difficulty, completion and grading in one place.'],
    ],
    headings: { login: 'Teacher sign in', register: 'Create your faculty account' },
    captions: {
      login: 'Sign in with your department email to open your studio.',
      register: 'Your teacher ID and department identify you to the CITE office.',
    },
  },
  admin: {
    label: 'Admin',
    slug: 'admin',
    eyebrow: 'CITE administration',
    title: 'Operate the<br />department.',
    blurb: 'Accounts, categories, platform health and the reports the department needs each term.',
    points: [
      ['Account oversight', 'Activate or deactivate any student or faculty account.'],
      ['Department reports', 'Quizzes, attempts and pass rates across CITE.'],
      ['System health', 'Database, cache and realtime status at a glance.'],
    ],
    headings: { login: 'Admin sign in', register: 'Admin sign in' },
    captions: {
      login: 'Administrator accounts are provisioned by the CITE office.',
      register: 'Administrator accounts are provisioned by the CITE office.',
    },
  },
};

function viewAuth(mode = 'login', role = 'student') {
  const isRegister = mode === 'register' && role !== 'admin';
  const portal = PORTALS[role] || PORTALS.student;
  const otherRole = role === 'student' ? 'teacher' : 'student';

  const academicFields = isRegister && role === 'student'
    ? `<div class="form-grid">
         <div class="field"><label for="studentId">Student ID</label>
           <input class="input" id="studentId" name="studentId" placeholder="2026-00123" required maxlength="30" />
         </div>
         <div class="field"><label for="section">Section</label>
           <input class="input" id="section" name="section" placeholder="BSIT-3A" required maxlength="40" />
         </div>
         <div class="field"><label for="program">Program</label>
           <input class="input" id="program" name="program" placeholder="BSIT" value="BSIT" maxlength="80" />
         </div>
         <div class="field"><label for="yearLevel">Year level</label>
           <select class="select" id="yearLevel" name="yearLevel">
             <option value="1st year">1st year</option>
             <option value="2nd year">2nd year</option>
             <option value="3rd year" selected>3rd year</option>
             <option value="4th year">4th year</option>
           </select>
         </div>
       </div>`
    : '';

  const teacherFields = isRegister && role === 'teacher'
    ? `<div class="form-grid">
         <div class="field"><label for="teacherId">Teacher ID</label>
           <input class="input" id="teacherId" name="teacherId" placeholder="CITE-F-014" required maxlength="30" />
         </div>
         <div class="field"><label for="department">Department</label>
           <input class="input" id="department" name="department" placeholder="CITE" value="CITE" required maxlength="80" />
         </div>
       </div>`
    : '';

  return layout(
    `<div class="auth-wrap">
      <aside class="auth-side">
        <span class="eyebrow">${esc(portal.eyebrow)}</span>
        <h2>${portal.title}</h2>
        <p>${esc(portal.blurb)}</p>
        <div class="auth-points">
          ${portal.points
            .map(
              ([title, copy]) => `<div class="auth-point"><span class="tick">✓</span><div><strong>${esc(title)}</strong><br /><span class="hint">${esc(copy)}</span></div></div>`,
            )
            .join('')}
        </div>
      </aside>
      <div class="auth-main">
        <div class="auth-card">
          <div class="tabs">
            <a class="tab ${!isRegister ? 'active' : ''}" href="#/${role}/login">Sign in</a>
            ${role !== 'admin' ? `<a class="tab ${isRegister ? 'active' : ''}" href="#/${role}/register">Create account</a>` : ''}
          </div>
          <span class="badge badge-soft">${esc(portal.label)} portal</span>
          <h1 style="margin-top:12px">${esc(portal.headings[isRegister ? 'register' : 'login'])}</h1>
          <p>${esc(portal.captions[isRegister ? 'register' : 'login'])}</p>

          <form class="form-stack" data-form="${isRegister ? 'register' : 'login'}" data-role="${esc(role)}">
            ${
              isRegister
                ? `<div class="form-grid">
                     <div class="field"><label for="firstName">First name</label><input class="input" id="firstName" name="firstName" placeholder="Maya" autocomplete="given-name" required maxlength="50" /></div>
                     <div class="field"><label for="lastName">Last name</label><input class="input" id="lastName" name="lastName" placeholder="Santos" autocomplete="family-name" maxlength="50" /></div>
                   </div>`
                : `<div class="field"><label for="identifier">${role === 'student' ? 'Student email or username' : 'Email or username'}</label>
                     <input class="input" id="identifier" name="identifier" placeholder="${role === 'student' ? 'you@cite.edu' : 'you@cite.edu'}" autocomplete="username" required />
                   </div>`
            }
            ${academicFields}
            ${teacherFields}
            ${
              isRegister
                ? `<div class="field"><label for="username">Username</label>
                     <input class="input" id="username" name="username" placeholder="maya.santos" autocomplete="username" required minlength="3" maxlength="30" />
                   </div>
                   <div class="field"><label for="email">University email</label>
                     <input class="input" id="email" name="email" type="email" placeholder="you@cite.edu" autocomplete="email" required />
                   </div>`
                : ''
            }
            <div class="field">
              <label for="password">Password</label>
              <input class="input" id="password" name="password" type="password" placeholder="••••••••" autocomplete="${isRegister ? 'new-password' : 'current-password'}" required minlength="${isRegister ? 8 : 1}" />
              ${isRegister ? '<span class="hint">At least 8 characters, with an uppercase letter and a number.</span>' : ''}
            </div>
            <button class="btn btn-primary btn-block" type="submit">${isRegister ? 'Create account' : 'Sign in'} →</button>
            <div class="auth-note">🔐 ${esc(portal.label)} sessions use secure httpOnly cookies — tokens never touch JavaScript.</div>
            <div class="auth-note" style="border-top:1px solid var(--border);padding-top:14px">
              ${role === 'admin'
                ? 'Looking for your classes? <a class="link" href="#/student/login">Student sign in</a> · <a class="link" href="#/teacher/login">Teacher sign in</a>'
                : `Wrong door? Continue to the <a class="link" href="#/${otherRole}/${isRegister ? 'register' : 'login'}">${esc(PORTALS[otherRole].label.toLowerCase())} portal</a>`}
            </div>
          </form>
        </div>
      </div>
    </div>`,
    { active: '' },
  );
}

/* ── views: student dashboard ───────────────────────────────────────────── */

function quizCard(quiz) {
  const category = quiz.category || {};
  const color = category.color || '#f97316';
  const badge = quiz.myAttempts
    ? `<span class="badge badge-success">Best ${pct(quiz.bestScore)}</span>`
    : quiz.analytics?.rating
      ? `<span class="badge badge-soft">★ ${Number(quiz.analytics.rating).toFixed(1)}</span>`
      : '<span class="badge badge-soft">New</span>';

  return `
    <article class="quiz-card" style="--card-accent: linear-gradient(90deg, ${esc(color)}, transparent)">
      <div class="quiz-card-top">
        <span class="quiz-cat"><i class="dot" style="--dot:${esc(color)}"></i>${esc(category.name || 'General')}</span>
        ${quiz.subject?.subjectCode ? `<span class="badge badge-soft">${esc(quiz.subject.subjectCode)}</span>` : ''}
        ${badge}
      </div>
      <h3>${esc(quiz.title)}</h3>
      <p class="desc">${esc(quiz.description || 'No description provided yet.')}</p>
      <div class="quiz-meta">
        <span>◈ ${esc(quiz.questionCount ?? quiz.questions?.length ?? '—')} questions</span>
        <span>◷ ${esc(quiz.estimatedMinutes ?? '—')} min</span>
        ${difficultyBadge(quiz.difficulty)}
      </div>
      <div class="quiz-card-foot">
        <span class="quiz-score">${quiz.myAttempts ? `${quiz.myAttempts} attempt${quiz.myAttempts > 1 ? 's' : ''}` : 'Not started'}</span>
        <a class="btn btn-primary btn-sm" href="#/quiz/${esc(quiz._id || quiz.id)}">${quiz.myAttempts ? 'Retake' : 'Start'} →</a>
      </div>
    </article>`;
}

async function viewDashboard() {
  const [{ data }, subjectsRes] = await Promise.all([
    api('/student/dashboard'),
    api('/student/subjects').catch(() => ({ data: [] })),
  ]);
  const s = data.summary || {};
  const subjects = subjectsRes.data || [];

  const recommended = (data.recommended || []).map(quizCard).join('');

  const recent = (data.recentResults || [])
    .map(
      (r) => `
      <tr>
        <td class="strong">${esc(r.quiz?.title || 'Quiz')}</td>
        <td><span class="badge ${r.score?.passed ? 'badge-success' : 'badge-danger'}">${pct(r.score?.percentage)}</span></td>
        <td class="num">${r.score?.totalScore ?? 0}/${r.score?.maxScore ?? 0}</td>
        <td>${timeAgo(r.completedAt)}</td>
        <td><a class="link" href="#/results/${esc(r._id)}">Review</a></td>
      </tr>`,
    )
    .join('');

  return layout(
    `<div class="page-head">
      <div>
        <span class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        <h1 style="font-size:clamp(1.8rem,4vw,2.6rem)">Hey ${esc(data.user?.profile?.firstName || data.user?.username || 'there')} 👋</h1>
        <p>${s.currentStreak > 0 ? `You're on a ${s.currentStreak}-day streak — keep it alive.` : 'Take a quiz today and start a new streak.'}</p>
      </div>
      <a class="btn btn-outline" href="#/quizzes">Browse all quizzes</a>
    </div>

    ${
      data.inProgress
        ? `<div class="card card-hover" style="border-color:rgba(124,140,255,.4);margin-bottom:22px">
            <div class="row" style="flex-wrap:wrap">
              <div>
                <span class="badge badge-warn">In progress</span>
                <h3 style="margin-top:10px">${esc(data.inProgress.quiz?.title || 'Unfinished quiz')}</h3>
                <p class="hint">Started ${timeAgo(data.inProgress.startedAt)} — the clock is still running.</p>
              </div>
              <a class="btn btn-primary" href="#/quiz/${esc(data.inProgress.quiz?._id)}">Resume attempt →</a>
            </div>
          </div>`
        : ''
    }

    <section class="section" style="margin-top:0">
      <div class="section-head">
        <h2>My subjects</h2>
        <div class="inline"><a href="#/subjects" class="link">All subjects →</a><button class="btn btn-outline btn-sm" data-action="enroll-open">＋ Join with QR</button></div>
      </div>
      ${subjects.length
        ? `<div class="subject-strip">${subjects.slice(0, 4).map(subjectTile).join('')}</div>`
        : `<div class="empty"><strong>No subjects yet</strong><span>Scan the QR code your teacher shows in class — or type the short code.</span><button class="btn btn-primary" data-action="enroll-open">Join a subject</button></div>`}
    </section>

    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Average score</div><div class="stat-value">${pct(s.averageScore)}</div><div class="stat-foot">Across ${s.quizzesTaken || 0} graded attempts</div></div>
      <div class="stat"><div class="stat-label">Current streak</div><div class="stat-value">${s.currentStreak || 0}<small> days</small></div><div class="stat-foot">Longest: ${s.longestStreak || 0} days</div></div>
      <div class="stat"><div class="stat-label">Total points</div><div class="stat-value">${money(s.totalPoints)}</div><div class="stat-foot">Pass rate ${pct(s.passRate)}</div></div>
      <div class="stat"><div class="stat-label">Available now</div><div class="stat-value">${money(s.quizzesAvailable)}<small> quizzes</small></div><div class="stat-foot">${s.unreadNotifications || 0} unread notifications</div></div>
    </div>

    ${
      (data.weakAreas || []).length
        ? `<div class="section" style="margin-top:26px">
            <div class="section-head"><h2>Focus areas</h2><a href="#/results">All results →</a></div>
            <div class="stat-grid">
              ${data.weakAreas
                .map(
                  (area) => `<div class="card tight">
                    <div class="row"><strong>${esc(area.category)}</strong><span class="badge badge-warn">${pct(area.averageScore)}</span></div>
                    <div class="progress" style="margin-top:12px"><i style="width:${Math.min(100, area.averageScore)}%;background:linear-gradient(90deg,#fb7185,#fbbf24)"></i></div>
                    <p class="hint" style="margin-top:8px">${area.attempts} attempt${area.attempts > 1 ? 's' : ''} — below the 60% pass line.</p>
                  </div>`,
                )
                .join('')}
            </div>
          </div>`
        : ''
    }

    <section class="section">
      <div class="section-head"><h2>Recommended for you</h2><a href="#/quizzes">See more →</a></div>
      ${recommended ? `<div class="quiz-grid">${recommended}</div>` : `<div class="empty"><strong>You've tried everything!</strong><span>New quizzes appear here as teachers publish them.</span></div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>Recent results</h2><a href="#/results">History →</a></div>
      ${
        recent
          ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quiz</th><th>Score</th><th>Points</th><th>When</th><th></th></tr></thead><tbody>${recent}</tbody></table></div>`
          : `<div class="empty"><strong>No results yet</strong><span>Finish a quiz to see your first score.</span></div>`
      }
    </section>`,
    { active: '#/dashboard' },
  );
}

/* ── views: quiz catalogue ──────────────────────────────────────────────── */

async function viewQuizzes(params = {}) {
  if (!state.categories) {
    state.categories = (await api('/categories').catch(() => ({ data: [] }))).data;
  }

  const query = new URLSearchParams({ limit: '24' });
  if (params.q) query.set('search', params.q);
  if (params.category) query.set('category', params.category);

  const endpoint = state.user ? `/student/quizzes?${query}` : `/quizzes?${query}`;
  const { data } = await api(endpoint).catch(async () => api(`/quizzes?${query}`));

  const chips = [{ _id: '', name: 'All' }, ...state.categories]
    .map((c) => {
      const id = c._id || c.id || '';
      return `<button class="chip ${String(params.category || '') === String(id) ? 'active' : ''}" data-action="filter-category" data-id="${esc(id)}">${esc(c.name)}</button>`;
    })
    .join('');

  return layout(
    `<div class="page-head">
      <div>
        <span class="eyebrow">Catalogue</span>
        <h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">Find your next challenge</h1>
        <p>${state.user ? 'Every published quiz, with your best scores.' : 'Sign in to track scores, streaks and attempt history.'}</p>
      </div>
      <form data-form="search-quizzes" class="inline">
        <input class="input" name="q" placeholder="Search quizzes…" value="${esc(params.q || '')}" style="min-width:220px" />
        <button class="btn btn-outline" type="submit">Search</button>
      </form>
    </div>
    <div class="filter-row">${chips}</div>
    ${
      (data || []).length
        ? `<div class="quiz-grid">${(data || []).map(quizCard).join('')}</div>`
        : `<div class="empty"><strong>No quizzes match those filters</strong><span>Try clearing the search or picking another category.</span></div>`
    }`,
    { active: '#/quizzes' },
  );
}

/* ── views: subjects & QR enrollment ────────────────────────────────────── */

function subjectTile(subject) {
  const enrollment = subject.myEnrollment || {};
  const id = subject.id || subject._id;
  return `<a class="subject-tile" href="#/subjects/${esc(id)}" style="--tile-accent:${esc(subject.color || '#f97316')}">
    <div class="row"><span class="badge badge-soft">${esc(subject.subjectCode)}</span><span class="hint">${esc(subject.section || '')}</span></div>
    <strong>${esc(subject.subjectName)}</strong>
    <span class="hint">${esc(subject.teacherName || 'Faculty')} · ${subject.quizCount || 0} quiz${subject.quizCount === 1 ? '' : 'zes'}</span>
    <div class="row" style="margin-top:auto">
      ${enrollment.blocked
        ? '<span class="badge badge-danger">Blocked</span>'
        : enrollment.status === 'pending'
          ? '<span class="badge badge-warn">Pending approval</span>'
          : `<span class="hint">${subject.attempts || 0} attempt${subject.attempts === 1 ? '' : 's'}</span><span class="badge ${subject.bestScore >= 60 ? 'badge-success' : 'badge-muted'}">Best ${pct(subject.bestScore)}</span>`}
    </div>
  </a>`;
}

async function viewMySubjects() {
  const { data } = await api('/student/subjects');
  const subjects = data || [];

  return layout(
    `<div class="page-head">
      <div><span class="eyebrow">Enrollment</span><h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">My subjects</h1><p>Every subject you joined by QR code, with your standing in each.</p></div>
      <button class="btn btn-primary" data-action="enroll-open">＋ Join with QR / code</button>
    </div>
    ${subjects.length
      ? `<div class="quiz-grid">${subjects.map(subjectTile).join('')}</div>`
      : `<div class="empty"><strong>You are not enrolled in a subject yet</strong><span>Ask your teacher for the enrollment QR code, then scan it or type the short code.</span><button class="btn btn-primary" data-action="enroll-open">Join your first subject</button></div>`}`,
    { active: '#/subjects' },
  );
}

async function viewSubject(id) {
  const { data } = await api(`/student/subjects/${id}`);
  const enrollment = data.myEnrollment || {};
  const quizzes = data.quizzes || [];

  return layout(
    `<div class="page-head">
      <div><span class="eyebrow">${esc(data.subjectCode)} · ${esc(data.section)}</span><h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">${esc(data.subjectName)}</h1><p>${esc(data.teacherName || 'Faculty')} · ${quizzes.length} published quiz${quizzes.length === 1 ? '' : 'zes'}</p></div>
      <a class="btn btn-ghost" href="#/subjects">← My subjects</a>
    </div>
    ${enrollment.blocked
      ? `<div class="card" style="border-color:rgba(248,113,113,.45);margin-bottom:18px"><strong>You are blocked from this subject</strong><p class="hint" style="margin-top:6px">${esc(enrollment.blockReason || 'Contact your teacher for details.')}</p></div>`
      : enrollment.status === 'pending'
        ? `<div class="card" style="border-color:rgba(251,191,36,.45);margin-bottom:18px"><strong>Waiting for teacher approval</strong><p class="hint" style="margin-top:6px">You will see the quizzes once your teacher approves your enrollment.</p></div>`
        : ''}
    ${enrollment.blocked || enrollment.status === 'pending'
      ? `<div class="empty"><strong>Quizzes are locked</strong><span>${enrollment.blocked ? 'Your teacher has blocked your access to this subject.' : 'Wait for your teacher to approve the enrollment.'}</span></div>`
      : quizzes.length
        ? `<div class="quiz-grid">${quizzes.map(quizCard).join('')}</div>`
        : `<div class="empty"><strong>No quizzes published in this subject yet</strong><span>Your teacher will publish them here.</span></div>`}`,
    { active: '#/subjects' },
  );
}

async function viewEnroll(code) {
  if (!state.user) {
    state.pendingEnroll = code ? `#/enroll/${code}` : null;
    location.hash = '#/student/login';
    return layout(
      `<div class="empty" style="margin-top:40px"><strong>Sign in to join</strong><span>Use your student account, then the invitation will reopen.</span><a class="btn btn-primary" href="#/student/login">Student sign in</a></div>`,
      { active: '' },
    );
  }

  if (state.user.role !== 'student') {
    return viewNotice({
      title: 'Student enrollment only',
      message: 'Only student accounts join subjects. Sign in with a student account to scan this code.',
      cta: '#/teacher/login',
      ctaLabel: 'Teacher sign in',
    });
  }

  if (!code) {
    return viewNotice({
      title: 'Enrollment code missing',
      message: 'Open the link from your teacher\'s QR code, or enter the short code in the enrollment dialog.',
      cta: '#/subjects',
      ctaLabel: 'My subjects',
    });
  }

  let preview;
  try {
    ({ data: preview } = await api('/student/enroll/preview', { method: 'POST', body: { code } }));
  } catch (err) {
    return viewNotice({
      title: 'This code is not usable',
      message: err.message,
      cta: '#/subjects',
      ctaLabel: 'Back to my subjects',
    });
  }

  const subject = preview.subject;
  const expires = preview.expiresAt ? new Date(preview.expiresAt).toLocaleString() : '—';

  return layout(
    `<div class="enroll-landing">
      <div class="card enroll-card" style="--card-accent:${esc(subject.color || '#f97316')}">
        <span class="eyebrow">Enrollment invitation</span>
        <h1 style="font-size:clamp(1.7rem,4vw,2.3rem);margin-top:8px">${esc(subject.subjectName)}</h1>
        <div class="inline" style="margin-top:6px">
          <span class="badge badge-soft">${esc(subject.subjectCode)}</span>
          <span class="badge badge-muted">${esc(subject.section)}</span>
          ${subject.program ? `<span class="badge badge-muted">${esc(subject.program)}</span>` : ''}
        </div>
        <p class="hint" style="margin-top:14px">${esc(subject.description || 'Join this subject to unlock its assessments.')}</p>
        <div class="kv" style="margin-top:16px"><span>Faculty</span><span>${esc(subject.teacherName || 'CITE faculty')}</span></div>
        <div class="kv"><span>Quizzes published</span><span>${subject.quizzes || 0}</span></div>
        <div class="kv"><span>Classmates enrolled</span><span>${subject.enrolledCount || 0}</span></div>
        <div class="kv"><span>Code expires</span><span>${esc(expires)}</span></div>

        ${preview.blocked
          ? `<div class="card tight" style="margin-top:16px;border-color:rgba(248,113,113,.45)"><strong>You cannot join this subject</strong><p class="hint" style="margin-top:6px">Your teacher has blocked your account from ${esc(subject.subjectCode)}.</p></div>`
          : preview.sectionMismatch
            ? `<div class="card tight" style="margin-top:16px;border-color:rgba(248,113,113,.45)"><strong>Different section</strong><p class="hint" style="margin-top:6px">This code opens ${esc(subject.section)}, but your account is in ${esc(preview.studentSection)}.</p></div>`
            : preview.alreadyEnrolled
            ? `<div class="card tight" style="margin-top:16px"><strong>You are already enrolled</strong><p class="hint" style="margin-top:6px">Head to your subjects to open the quizzes.</p></div>
               <a class="btn btn-primary btn-block" href="#/subjects/${esc(subject.id)}" style="margin-top:14px">Open subject →</a>`
            : preview.pendingApproval
              ? `<div class="card tight" style="margin-top:16px"><strong>Waiting for approval</strong><p class="hint" style="margin-top:6px">Your teacher will approve the enrollment soon.</p></div>`
              : `<button class="btn btn-primary btn-block" data-action="enroll-confirm" data-code="${esc(code)}" style="margin-top:18px">Join ${esc(subject.subjectCode)} →</button>`}
      </div>
    </div>`,
    { active: '#/subjects' },
  );
}

/* ── views: quiz runner ─────────────────────────────────────────────────── */

function answerText(question, value) {
  if (value === null || value === undefined || value === '') return '—';
  if (question?.type === 'true_false') return value === true || value === 'true' ? 'True' : 'False';
  if (question?.type === 'multiple_choice' && question.options) {
    const found = question.options.find(
      (o, i) => String(o.index ?? i) === String(value) || o.text === value,
    );
    return found?.text || String(value);
  }
  return String(value);
}

async function viewQuizRunner(id) {
  let data;
  try {
    ({ data } = await api(`/student/quizzes/${id}/start`, { method: 'POST', body: {} }));
  } catch (err) {
    if (err.status === 403) {
      return viewNotice({
        title: 'This quiz is not open to you',
        message: err.message,
        cta: state.user?.role === 'student' ? '#/subjects' : '#/dashboard',
        ctaLabel: state.user?.role === 'student' ? 'My subjects' : 'Dashboard',
      });
    }
    throw err;
  }

  const { quiz, attemptId, deadline } = data;

  state.runner = {
    quiz,
    attemptId,
    index: 0,
    answers: {},
    startedAt: Date.now(),
    deadline: deadline ? new Date(deadline).getTime() : null,
    submitting: false,
  };

  connectSocket(quiz.id);

  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(tickTimer, 1000);

  const view = `
    <div class="runner">
      <div>
        <div class="q-head">
          <div>
            <span class="eyebrow" style="margin-bottom:4px">${esc(quiz.title)}</span>
            <div class="hint">${quiz.questions.length} questions · ${quiz.totalPoints} points · pass at ${quiz.settings?.passingScore ?? 60}%</div>
          </div>
          <span class="badge badge-soft" id="participants">◉ live</span>
        </div>
        <div class="card question-card" id="question-card"></div>
        <div class="q-nav">
          <button class="btn btn-ghost" data-action="prev-question">← Previous</button>
          <span class="hint" id="q-progress"></span>
          <button class="btn btn-outline" data-action="next-question">Next →</button>
        </div>
      </div>
      <aside class="side-panel">
        <div class="timer" id="timer"><span>Time left</span><strong id="timer-value">--:--</strong></div>
        <div class="card tight">
          <div class="row" style="margin-bottom:12px"><strong style="font-size:12.5px;color:var(--text-soft)">Questions</strong><span class="hint" id="answered-count"></span></div>
          <div class="q-dots" id="q-dots"></div>
        </div>
        <button class="btn btn-primary btn-block" data-action="submit-quiz" id="submit-btn">Submit quiz</button>
        <p class="hint" style="text-align:center">Answers are graded on the server when you submit.</p>
      </aside>
    </div>`;

  setTimeout(() => {
    renderQuestion();
    tickTimer();
  }, 0);

  return layout(view, { active: '#/quizzes' });
}

function renderQuestion() {
  const runner = state.runner;
  if (!runner) return;
  const { quiz, index } = runner;
  const question = quiz.questions[index];
  const selected = runner.answers[question.id];

  const card = document.getElementById('question-card');
  if (!card) return;

  let body = '';

  if (question.type === 'multiple_choice') {
    body = `<div class="options">${question.options
      .map(
        (opt) => `<button class="option ${String(selected) === String(opt.index) ? 'selected' : ''}" data-action="answer" data-value="${esc(opt.index)}">
          <span class="key">${String.fromCharCode(65 + question.options.findIndex((o) => String(o.index) === String(opt.index)))}</span>
          ${esc(opt.text)}
        </button>`,
      )
      .join('')}</div>`;
  } else if (question.type === 'true_false') {
    body = `<div class="options">${['true', 'false']
      .map(
        (value, i) => `<button class="option ${String(selected) === value ? 'selected' : ''}" data-action="answer" data-value="${value}">
          <span class="key">${i === 0 ? 'T' : 'F'}</span>${i === 0 ? 'True' : 'False'}
        </button>`,
      )
      .join('')}</div>`;
  } else if (question.type === 'short_answer') {
    body = `<input class="input" id="short-answer" placeholder="Type your answer…" value="${esc(selected || '')}" autocomplete="off" />`;
  } else {
    body = `<textarea class="textarea" id="essay-answer" placeholder="Write your answer…" rows="7">${esc(selected || '')}</textarea>
            <p class="hint" style="margin-top:8px">Essay answers are graded by your teacher.</p>`;
  }

  card.innerHTML = `
    <div class="q-head">
      <span class="q-index">Question ${index + 1} / ${quiz.questions.length}</span>
      <span class="badge badge-muted">${esc(question.points)} pt${question.points > 1 ? 's' : ''}</span>
    </div>
    <h2 class="question-text">${esc(question.question)}</h2>
    ${body}`;

  card.querySelectorAll('[data-action="answer"]').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.runner.answers[question.id] = question.type === 'true_false' ? btn.dataset.value === 'true' : Number(btn.dataset.value);
      renderQuestion();
      renderDots();
    }),
  );

  const short = document.getElementById('short-answer');
  if (short) {
    short.addEventListener('input', () => {
      state.runner.answers[question.id] = short.value;
      renderDots();
    });
  }
  const essay = document.getElementById('essay-answer');
  if (essay) {
    essay.addEventListener('input', () => {
      state.runner.answers[question.id] = essay.value;
      renderDots();
    });
  }

  const progress = document.getElementById('q-progress');
  if (progress) progress.textContent = `${Object.keys(state.runner.answers).length} of ${quiz.questions.length} answered`;
  renderDots();
}

function renderDots() {
  const runner = state.runner;
  if (!runner) return;
  const dots = document.getElementById('q-dots');
  if (!dots) return;

  dots.innerHTML = runner.quiz.questions
    .map((q, i) => {
      const answered = runner.answers[q.id] !== undefined && runner.answers[q.id] !== '';
      return `<button class="q-dot ${answered ? 'answered' : ''} ${i === runner.index ? 'current' : ''}" data-action="goto-question" data-index="${i}">${i + 1}</button>`;
    })
    .join('');

  const answeredCount = document.getElementById('answered-count');
  if (answeredCount) answeredCount.textContent = `${Object.keys(runner.answers).length}/${runner.quiz.questions.length}`;
}

function tickTimer() {
  const value = document.getElementById('timer-value');
  const box = document.getElementById('timer');
  if (!value || !state.runner) return;

  const { deadline, startedAt } = state.runner;
  const remaining = deadline ? Math.max(0, Math.round((deadline - Date.now()) / 1000)) : null;

  if (remaining === null) {
    value.textContent = secondsToClock((Date.now() - startedAt) / 1000);
    return;
  }

  value.textContent = secondsToClock(remaining);
  box?.classList.toggle('warning', remaining <= 60 && remaining > 15);
  box?.classList.toggle('danger', remaining <= 15);

  if (remaining <= 0 && !state.runner.submitting) {
    state.runner.submitting = true;
    toast('Time is up — submitting your answers.', { title: 'Time up' });
    submitQuiz();
  }
}

async function submitQuiz() {
  const runner = state.runner;
  if (!runner) return;

  const unanswered = runner.quiz.questions.filter((q) => {
    const a = runner.answers[q.id];
    return a === undefined || a === '' || a === null;
  });

  if (!runner.submitting && unanswered.length) {
    const ok = await confirmDialog({
      title: `${unanswered.length} unanswered question${unanswered.length > 1 ? 's' : ''}`,
      message: 'Unanswered questions score zero. Submit anyway?',
      confirmLabel: 'Submit',
    });
    if (!ok) return;
  }

  runner.submitting = true;
  const btn = document.getElementById('submit-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Grading…';
  }

  try {
    const payload = {
      attemptId: runner.attemptId,
      timeSpent: Math.round((Date.now() - runner.startedAt) / 1000),
      answers: runner.quiz.questions
        .filter((q) => runner.answers[q.id] !== undefined)
        .map((q) => ({ questionId: q.id, answer: runner.answers[q.id] })),
    };
    const { data } = await api(`/student/quizzes/${runner.quiz.id}/submit`, { method: 'POST', body: payload });
    state.lastResult = data.result;
    clearTimers();
    location.hash = `#/results/${data.result._id}`;
  } catch (err) {
    runner.submitting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Submit quiz';
    }
    toast(err.message, { type: 'error' });
  }
}

function clearTimers() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ── views: results ─────────────────────────────────────────────────────── */

function reviewList(result) {
  return (result.answers || [])
    .map((answer) => {
      const status = answer.needsManualGrading ? 'pending' : answer.isCorrect ? 'ok' : 'bad';
      const label = answer.needsManualGrading
        ? '<span class="badge badge-warn">Awaiting review</span>'
        : answer.isCorrect
          ? '<span class="badge badge-success">Correct</span>'
          : '<span class="badge badge-danger">Incorrect</span>';

      const question = { type: answer.type, options: answer.options };

      return `<article class="review-item ${status}">
        <div class="review-head">
          <div class="review-q">${esc(answer.questionText || 'Question')}</div>
          ${label}
        </div>
        <div class="review-line"><span>Your answer:</span><b>${esc(answerText(question, answer.studentAnswer))}</b></div>
        ${answer.correctAnswer !== undefined && answer.correctAnswer !== null && !answer.needsManualGrading
          ? `<div class="review-line"><span>Correct answer:</span><span class="answer-chip ${answer.isCorrect ? '' : 'bad'}">${esc(answerText(question, answer.correctAnswer))}</span></div>`
          : ''}
        ${answer.pointsEarned !== undefined
          ? `<div class="review-line"><span>Points:</span><b>${answer.pointsEarned} / ${answer.maxPoints}</b></div>`
          : ''}
        ${answer.feedback ? `<div class="explain"><strong>Teacher feedback:</strong> ${esc(answer.feedback)}</div>` : ''}
        ${answer.explanation ? `<div class="explain">💡 ${esc(answer.explanation)}</div>` : ''}
      </article>`;
    })
    .join('');
}

async function viewResult(id) {
  const { data } = state.lastResult && state.lastResult._id === id
    ? { data: state.lastResult }
    : await api(`/student/results/${id}`);

  if (data.inProgress) {
    return layout(
      `<div class="empty"><strong>This attempt is still open</strong><span>Finish the quiz to see your score.</span><a class="btn btn-primary" href="#/quiz/${esc(data.resultId)}">Resume</a></div>`,
      { active: '#/dashboard' },
    );
  }

  const score = data.score || {};
  const pctValue = Math.round(score.percentage || 0);
  const passed = score.passed;
  const color = passed ? '#34d399' : '#fb7185';

  return layout(
    `<div class="page-head"><div><span class="eyebrow">Result</span><h1 style="font-size:clamp(1.7rem,3.6vw,2.3rem)">${esc(data.quiz?.title || 'Quiz')}</h1><p>Attempt ${data.attemptNumber || 1} · ${timeAgo(data.completedAt)}</p></div><a class="btn btn-outline" href="#/results">All results</a></div>
     <div class="card score-hero">
       <div class="ring" style="--value:${pctValue};--ring-color:${color}">
         <div class="ring-value"><strong>${pctValue}%</strong><span>${passed ? 'Passed' : 'Not passed'}</span></div>
       </div>
       <div class="score-copy">
         <h2>${passed ? 'Great work — that’s a pass.' : 'Close — review and try again.'}</h2>
         <p>${passed ? 'You cleared the passing threshold. Check the breakdown to see what you nailed and what to revisit.' : 'Review the explanations below; a retake is the fastest way to lock it in.'}</p>
         <div class="score-facts">
           <div class="score-fact"><strong>${score.totalScore ?? 0}/${score.maxScore ?? 0}</strong><span>Points</span></div>
           <div class="score-fact"><strong>${data.answers?.filter((a) => a.isCorrect).length || 0}/${data.answers?.length || 0}</strong><span>Correct</span></div>
           <div class="score-fact"><strong>${secondsToClock(data.timeSpent)}</strong><span>Time</span></div>
           <div class="score-fact"><strong>${esc(data.status || 'graded')}</strong><span>Status</span></div>
         </div>
       </div>
     </div>
     <section class="section">
       <div class="section-head"><h2>Answer review</h2><span class="hint">${data.answers?.some((a) => a.correctAnswer !== undefined) ? 'Answer key included' : 'Answer key hidden by your teacher'}</span></div>
       <div class="review">${reviewList(data)}</div>
     </section>`,
    { active: '#/dashboard' },
  );
}

async function viewResults() {
  const { data } = await api('/student/results?limit=50');

  const rows = (data || [])
    .map(
      (r) => `<tr>
        <td class="strong">${esc(r.quiz?.title || 'Quiz')}</td>
        <td><span class="badge ${r.score?.passed ? 'badge-success' : 'badge-danger'}">${pct(r.score?.percentage)}</span></td>
        <td class="num">${r.score?.totalScore ?? 0}/${r.score?.maxScore ?? 0}</td>
        <td>${secondsToClock(r.timeSpent)}</td>
        <td>${esc(r.status)}</td>
        <td>${timeAgo(r.completedAt || r.createdAt)}</td>
        <td><a class="link" href="#/results/${esc(r._id)}">Review →</a></td>
      </tr>`,
    )
    .join('');

  return layout(
    `<div class="page-head"><div><span class="eyebrow">History</span><h1 style="font-size:clamp(1.8rem,4vw,2.3rem)">Your results</h1><p>Every graded attempt, newest first.</p></div><a class="btn btn-primary" href="#/quizzes">Take another quiz</a></div>
     ${
       rows
         ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quiz</th><th>Score</th><th>Points</th><th>Time</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
         : `<div class="empty"><strong>No results yet</strong><span>Your graded attempts will appear here.</span><a class="btn btn-primary" href="#/quizzes">Find a quiz</a></div>`
     }`,
    { active: '#/dashboard' },
  );
}

/* ── views: teacher studio ──────────────────────────────────────────────── */

async function viewStudio() {
  const { data } = await api('/teacher/dashboard');
  const s = data.summary || {};

  const rows = (data.recentQuizzes || [])
    .map(
      (q) => `<tr>
        <td class="strong">${esc(q.title)}</td>
        <td>${difficultyBadge(q.difficulty)}</td>
        <td>${q.isPublished ? '<span class="badge badge-success">Live</span>' : '<span class="badge badge-muted">Draft</span>'}</td>
        <td class="num">${q.questionCount ?? q.questions?.length ?? '—'}</td>
        <td class="num">${q.analytics?.completedAttempts || 0}</td>
        <td class="num">${pct(q.analytics?.averageScore)}</td>
        <td class="row" style="justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" data-action="toggle-publish" data-id="${esc(q._id)}" data-published="${q.isPublished}">${q.isPublished ? 'Unpublish' : 'Publish'}</button>
          <a class="btn btn-outline btn-sm" href="#/studio/${esc(q._id)}/analytics">Analytics</a>
        </td>
      </tr>`,
    )
    .join('');

  const top = (data.topQuizzes || [])
    .map(
      (q) => `<div class="kv"><span>${esc(q.title)}</span><span><strong>${q.attempts || 0}</strong> attempts · ${pct(q.avgScore)}</span></div>`,
    )
    .join('');

  return layout(
    `<div class="page-head">
      <div><span class="eyebrow">Studio</span><h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">Teaching overview</h1><p>Subjects, QR enrollment, quizzes and class analytics in one place.</p></div>
      <div class="inline"><a class="btn btn-outline" href="#/studio/subjects">Subjects</a><a class="btn btn-primary" href="#/studio/new">＋ New quiz</a></div>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Subjects</div><div class="stat-value">${s.subjects || 0}</div><div class="stat-foot">${s.enrolledStudents || 0} students enrolled${s.pendingEnrollments ? ` · ${s.pendingEnrollments} pending` : ''}</div></div>
      <div class="stat"><div class="stat-label">Quizzes</div><div class="stat-value">${s.quizzes || 0}</div><div class="stat-foot">${s.published || 0} published · ${s.drafts || 0} drafts</div></div>
      <div class="stat"><div class="stat-label">Attempts</div><div class="stat-value">${money(s.attempts)}</div><div class="stat-foot">${s.uniqueStudents || 0} unique students</div></div>
      <div class="stat"><div class="stat-label">Average score</div><div class="stat-value">${pct(s.averageScore)}</div><div class="stat-foot">Pass rate ${pct(s.passRate)} · ${s.pendingGrading || 0} to grade</div></div>
    </div>
    ${s.pendingEnrollments
      ? `<div class="card" style="margin-top:20px;border-color:rgba(251,191,36,.4)"><div class="row"><div><strong>${s.pendingEnrollments} enrollment request${s.pendingEnrollments === 1 ? '' : 's'} waiting</strong><p class="hint">Approve by opening the subject roster.</p></div><a class="btn btn-outline btn-sm" href="#/studio/subjects">Review</a></div></div>`
      : ''}

    <div class="split section">
      <div>
        <div class="section-head"><h2>Recent quizzes</h2><a href="#/studio/new">Create →</a></div>
        ${
          rows
            ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quiz</th><th>Level</th><th>Status</th><th>Qs</th><th>Attempts</th><th>Avg</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><strong>No quizzes yet</strong><span>Create your first quiz and publish it to the class.</span><a class="btn btn-primary" href="#/studio/new">Create quiz</a></div>`
        }
      </div>
      <aside class="stack">
        <div class="card">
          <div class="section-head" style="margin-bottom:12px"><h3>Top performers</h3></div>
          ${top || '<p class="hint">No attempts recorded yet.</p>'}
        </div>
        <div class="card">
          <div class="section-head" style="margin-bottom:12px"><h3>Hardest questions</h3></div>
          ${
            (data.hardestQuestions || []).length
              ? data.hardestQuestions
                  .map(
                    (q) => `<div style="margin-bottom:14px">
                      <p style="font-size:13px;color:var(--text-soft)">${esc(q.text || 'Question')}</p>
                      <div class="progress" style="margin-top:6px"><i style="width:${q.correctRate || 0}%;background:linear-gradient(90deg,#fb7185,#fbbf24)"></i></div>
                      <span class="hint">${pct(q.correctRate)} correct · ${q.attempts} attempts</span>
                    </div>`,
                  )
                  .join('')
              : '<p class="hint">Not enough attempts yet.</p>'
          }
        </div>
      </aside>
    </div>`,
    { active: '#/studio' },
  );
}

/* ── teacher: subjects ──────────────────────────────────────────────────── */

async function viewStudioSubjects() {
  const { data } = await api('/teacher/subjects');
  const subjects = data || [];

  const cards = subjects
    .map(
      (subject) => `<article class="card subject-card" style="--card-accent:${esc(subject.color || '#f97316')}">
        <div class="row"><span class="badge badge-soft">${esc(subject.subjectCode)}</span><span class="badge badge-muted">${esc(subject.section)}</span></div>
        <h3 style="margin-top:10px">${esc(subject.subjectName)}</h3>
        <p class="hint">${subject.enrolledCount} enrolled · ${subject.quizCount || 0} quiz${subject.quizCount === 1 ? '' : 'zes'}${subject.blockedCount ? ` · ${subject.blockedCount} blocked` : ''}</p>
        <div class="row" style="margin-top:12px">
          <span class="badge ${subject.enrollmentState?.active ? 'badge-success' : 'badge-muted'}">${subject.enrollmentState?.active ? 'QR active' : 'No active QR'}</span>
          <span class="hint">${expiryLabel(subject.enrollmentState?.expiresAt)}</span>
        </div>
        <div class="row" style="margin-top:14px">
          <button class="btn btn-outline btn-sm" data-action="subject-qr" data-id="${esc(subject.id || subject._id)}">QR code</button>
          <a class="btn btn-primary btn-sm" href="#/studio/subjects/${esc(subject.id || subject._id)}">Open roster →</a>
        </div>
      </article>`,
    )
    .join('');

  return layout(
    `<div class="page-head">
      <div><span class="eyebrow">Studio · enrollment</span><h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">Subjects &amp; QR codes</h1><p>Create a subject, project its QR code, and manage the section roster.</p></div>
      <div class="inline"><button class="btn btn-primary" data-action="subject-new">＋ New subject</button><a class="btn btn-ghost" href="#/studio">← Studio</a></div>
    </div>
    ${subjects.length
      ? `<div class="stat-grid three">${cards}</div>`
      : `<div class="empty"><strong>No subjects yet</strong><span>Create your first subject to mint an enrollment QR code for the class.</span><button class="btn btn-primary" data-action="subject-new">Create subject</button></div>`}`,
    { active: '#/studio/subjects' },
  );
}

async function viewSubjectDetail(id) {
  const { data } = await api(`/teacher/subjects/${id}`);
  const students = data.students || [];

  const rows = students
    .map(
      (row) => `<tr>
        <td><div class="inline"><span class="avatar" style="width:28px;height:28px;font-size:11px">${esc(initials(row.student?.name || row.student?.username || '?'))}</span>
          <div><span class="strong">${esc(row.student?.name || row.student?.username || 'Student')}</span><br /><span class="hint">${esc(row.student?.studentId || row.student?.email || '')}</span></div></div></td>
        <td>${esc(row.student?.section || '—')}</td>
        <td class="num">${row.attempts}</td>
        <td class="num">${pct(row.averageScore)}</td>
        <td>${row.blocked ? `<span class="badge badge-danger" title="${esc(row.blockReason || '')}">Blocked</span>` : row.status === 'pending' ? '<span class="badge badge-warn">Pending</span>' : '<span class="badge badge-success">Active</span>'}</td>
        <td class="row" style="justify-content:flex-end">
          ${row.blocked
            ? `<button class="btn btn-ghost btn-sm" data-action="student-unblock" data-subject="${esc(data.id)}" data-student="${esc(row.student?.id)}">Unblock</button>`
            : `<button class="btn btn-ghost btn-sm" data-action="student-block" data-subject="${esc(data.id)}" data-student="${esc(row.student?.id)}" data-name="${esc(row.student?.name || row.student?.username || 'student')}">Block</button>`}
          <button class="btn btn-danger btn-sm" data-action="student-remove" data-subject="${esc(data.id)}" data-student="${esc(row.student?.id)}" data-name="${esc(row.student?.name || row.student?.username || 'student')}">Remove</button>
        </td>
      </tr>`,
    )
    .join('');

  return layout(
    `<div class="page-head">
      <div><span class="eyebrow">${esc(data.subjectCode)} · ${esc(data.section)}</span><h1 style="font-size:clamp(1.7rem,4vw,2.3rem)">${esc(data.subjectName)}</h1><p>${students.filter((s) => !s.blocked).length} enrolled · ${data.quizzes?.length || 0} quiz${data.quizzes?.length === 1 ? '' : 'zes'} · ${esc(data.program || 'CITE')}</p></div>
      <div class="inline"><button class="btn btn-outline" data-action="subject-qr" data-id="${esc(data.id)}">QR code</button><a class="btn btn-primary" href="#/studio/new?subject=${esc(data.id)}">＋ Quiz for this subject</a></div>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="stat-label">Enrolled</div><div class="stat-value">${students.filter((s) => !s.blocked).length}</div><div class="stat-foot">Capacity ${data.enrollment?.maxStudents || 50}</div></div>
      <div class="stat"><div class="stat-label">Blocked</div><div class="stat-value">${students.filter((s) => s.blocked).length}</div><div class="stat-foot">Cannot open subject quizzes</div></div>
      <div class="stat"><div class="stat-label">QR enrollment</div><div class="stat-value">${data.enrollmentState?.active ? 'Live' : 'Off'}</div><div class="stat-foot">${data.enrollment?.allowQr === false ? 'Disabled' : 'Code required'}</div></div>
      <div class="stat"><div class="stat-label">Quizzes</div><div class="stat-value">${(data.quizzes || []).filter((q) => q.isPublished).length}<small> live</small></div><div class="stat-foot">${(data.quizzes?.length || 0) - (data.quizzes || []).filter((q) => q.isPublished).length} drafts</div></div>
    </div>

    <section class="section">
      <div class="section-head"><h2>Roster</h2><div class="inline" style="gap:12px"><span class="hint">Blocked students keep their history but cannot open this subject's quizzes.</span><a class="btn btn-outline btn-sm" href="/api/teacher/subjects/${esc(data.id)}/roster" download>Export CSV</a></div></div>
      ${students.length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Student</th><th>Section</th><th>Attempts</th><th>Average</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><strong>Nobody enrolled yet</strong><span>Generate the QR code and have students scan it during class.</span><button class="btn btn-primary" data-action="subject-qr" data-id="${esc(data.id)}">Show QR code</button></div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>Quizzes in this subject</h2><a href="#/studio/new?subject=${esc(data.id)}">Add →</a></div>
      ${(data.quizzes || []).length
        ? `<div class="table-wrap"><table class="table"><thead><tr><th>Quiz</th><th>Status</th><th>Attempts</th><th>Avg</th><th></th></tr></thead><tbody>${(data.quizzes || [])
            .map(
              (q) => `<tr><td class="strong">${esc(q.title)}</td><td>${q.isPublished ? '<span class="badge badge-success">Live</span>' : '<span class="badge badge-muted">Draft</span>'}</td><td class="num">${q.analytics?.completedAttempts || 0}</td><td class="num">${pct(q.analytics?.averageScore)}</td><td><a class="link" href="#/studio/${esc(q._id)}/analytics">Analytics</a></td></tr>`,
            )
            .join('')}</tbody></table></div>`
        : `<div class="empty"><strong>No quizzes yet</strong><span>Create one and it will only be visible to this subject's students.</span><a class="btn btn-primary" href="#/studio/new?subject=${esc(data.id)}">Create quiz</a></div>`}
    </section>

    <section class="section">
      <div class="section-head"><h2>Enrollment settings</h2></div>
      <div class="card">
        <div class="kv"><span>Allow QR enrollment</span><span>${data.enrollment?.allowQr === false ? 'No' : 'Yes'}</span></div>
        <div class="kv"><span>Enrollment open</span><span>${data.enrollment?.isOpen === false ? 'No' : 'Yes'}</span></div>
        <div class="kv"><span>Require teacher approval</span><span>${data.enrollment?.requireApproval ? 'Yes' : 'No'}</span></div>
        <div class="kv"><span>Section</span><span>${esc(data.section)}</span></div>
        <div class="kv"><span>Program</span><span>${esc(data.program || '—')}</span></div>
      </div>
    </section>`,
    { active: '#/studio/subjects' },
  );
}

/* quiz builder */

const builder = {
  questions: [],
  categories: [],
  subjects: [],
  subjectId: '',
};

function emptyQuestion(type = 'multiple_choice') {
  return {
    type,
    question: '',
    options: [{ text: '' }, { text: '' }, { text: '' }],
    correctAnswer: 0,
    points: 10,
    explanation: '',
    difficulty: 'medium',
  };
}

async function viewQuizBuilder(params = {}) {
  if (!builder.categories.length) {
    builder.categories = (await api('/categories').catch(() => ({ data: [] }))).data || [];
  }
  builder.subjects = (await api('/teacher/subjects').catch(() => ({ data: [] }))).data || [];
  builder.subjectId = params.subject || '';
  if (!builder.questions.length) builder.questions = [emptyQuestion()];

  // The router swaps innerHTML after this handler resolves, so draw the
  // question editors on the next tick.
  setTimeout(renderBuilderQuestions, 0);

  return layout(
    `<div class="page-head"><div><span class="eyebrow">Studio · new</span><h1 style="font-size:clamp(1.7rem,3.6vw,2.3rem)">Create a quiz</h1><p>Questions are graded on the server; students never see the answer key before submitting.</p></div><a class="btn btn-ghost" href="#/studio">← Back to studio</a></div>
     <form data-form="create-quiz" class="stack">
       <div class="card form-stack">
         <div class="form-grid">
           <div class="field" style="grid-column:1/-1"><label for="title">Quiz title</label><input class="input" id="title" name="title" placeholder="Solar System Basics" required maxlength="140" /></div>
           <div class="field" style="grid-column:1/-1"><label for="description">Description</label><textarea class="textarea" id="description" name="description" placeholder="What will students practice?" maxlength="2000"></textarea></div>
           <div class="field"><label for="category">Category</label><div class="inline" style="gap:6px"><select class="select" id="category" name="category" required>${builder.categories.map((c) => `<option value="${esc(c._id || c.id)}">${esc(c.name)}</option>`).join('')}</select><button class="btn btn-ghost btn-sm" type="button" data-action="category-new" title="Add your own category">＋</button></div></div>
           <div class="field"><label for="subject">Subject (optional)</label><select class="select" id="subject" name="subject">
             <option value="">Open catalogue — any student</option>
             ${builder.subjects.map((s) => `<option value="${esc(s.id || s._id)}" ${String(builder.subjectId) === String(s.id || s._id) ? 'selected' : ''}>${esc(s.subjectCode)} · ${esc(s.section)} — ${esc(s.subjectName)}</option>`).join('')}
           </select><span class="hint">Subject quizzes are visible only to enrolled, unblocked students.</span></div>
           <div class="field"><label for="difficulty">Difficulty</label><select class="select" id="difficulty" name="difficulty"><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></div>
           <div class="field"><label for="passingScore">Passing score (%)</label><input class="input" id="passingScore" name="passingScore" type="number" min="0" max="100" value="60" /></div>
           <div class="field"><label for="timePerQuestion">Seconds per question</label><input class="input" id="timePerQuestion" name="timePerQuestion" type="number" min="10" max="3600" value="60" /></div>
           <div class="field"><label for="maxAttempts">Attempts allowed</label><input class="input" id="maxAttempts" name="maxAttempts" type="number" min="1" max="20" value="1" /><span class="hint">CITE assessments default to one attempt.</span></div>
         </div>
         <div class="inline" style="gap:20px">
           <label class="check"><input type="checkbox" name="randomizeQuestions" /> Shuffle questions</label>
           <label class="check"><input type="checkbox" name="showCorrectAnswers" checked /> Show answers after grading</label>
           <label class="check"><input type="checkbox" name="allowRetakes" /> Allow retakes</label>
         </div>
       </div>

       <div class="section-head"><h2>Questions</h2><button class="btn btn-outline btn-sm" type="button" data-action="add-question">＋ Add question</button></div>
       <div class="stack" id="question-list"></div>

       <div class="card row" style="flex-wrap:wrap">
         <div><strong>Ready to publish?</strong><p class="hint">Publishing notifies students. You can also save as a draft.</p></div>
         <div class="inline">
           <button class="btn btn-outline" type="submit" name="draft" value="1">Save draft</button>
           <button class="btn btn-primary" type="submit">Publish quiz →</button>
         </div>
       </div>
     </form>`,
    { active: '#/studio' },
  );
}

function renderBuilderQuestions() {
  const list = document.getElementById('question-list');
  if (!list) return;

  list.innerHTML = builder.questions
    .map((q, i) => {
      const type = q.type;
      let answerField = '';

      if (type === 'multiple_choice') {
        answerField = `<div class="field"><label>Options — select the correct one</label>
          <div class="stack" style="gap:8px">
            ${q.options
              .map(
                (opt, oi) => `<div class="option-row">
                  <input type="radio" name="correct-${i}" value="${oi}" ${Number(q.correctAnswer) === oi ? 'checked' : ''} data-q="${i}" data-correct="${oi}" />
                  <input class="input" placeholder="Option ${oi + 1}" value="${esc(opt.text)}" data-q="${i}" data-option="${oi}" />
                  ${q.options.length > 2 ? `<button class="btn-icon" type="button" data-action="remove-option" data-q="${i}" data-option="${oi}">−</button>` : ''}
                </div>`,
              )
              .join('')}
            <button class="btn btn-ghost btn-sm" type="button" data-action="add-option" data-q="${i}">＋ Add option</button>
          </div></div>`;
      } else if (type === 'true_false') {
        answerField = `<div class="field"><label>Correct answer</label>
          <select class="select" data-q="${i}" data-answer>
            <option value="true" ${q.correctAnswer === true ? 'selected' : ''}>True</option>
            <option value="false" ${q.correctAnswer === false ? 'selected' : ''}>False</option>
          </select></div>`;
      } else if (type === 'short_answer') {
        answerField = `<div class="field"><label>Accepted answer</label>
          <input class="input" data-q="${i}" data-answer value="${esc(q.correctAnswer || '')}" placeholder="Case-insensitive; separate alternatives with |" /></div>`;
      } else {
        answerField = `<p class="hint">Essay answers are graded manually from the grading queue.</p>`;
      }

      return `<div class="question-editor" data-q="${i}">
        <div class="editor-head">
          <strong>Question ${i + 1}</strong>
          <div class="inline">
            <select class="select" data-q="${i}" data-type style="width:auto">
              ${['multiple_choice', 'true_false', 'short_answer', 'essay']
                .map((t) => `<option value="${t}" ${type === t ? 'selected' : ''}>${t.replace('_', ' ')}</option>`)
                .join('')}
            </select>
            ${builder.questions.length > 1 ? `<button class="btn-icon" type="button" data-action="remove-question" data-q="${i}">✕</button>` : ''}
          </div>
        </div>
        <div class="field"><label>Question</label><textarea class="textarea" data-q="${i}" data-text placeholder="Ask something clear and specific…" rows="2">${esc(q.question)}</textarea></div>
        ${answerField}
        <div class="form-grid">
          <div class="field"><label>Points</label><input class="input" type="number" min="1" max="100" value="${esc(q.points)}" data-q="${i}" data-points /></div>
          <div class="field"><label>Difficulty</label><select class="select" data-q="${i}" data-difficulty>${['easy', 'medium', 'hard'].map((d) => `<option value="${d}" ${q.difficulty === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
          <div class="field"><label>Explanation (optional)</label><input class="input" data-q="${i}" data-explanation value="${esc(q.explanation || '')}" placeholder="Why is that the answer?" /></div>
        </div>
      </div>`;
    })
    .join('');

  bindBuilderEvents();
}

function bindBuilderEvents() {
  const list = document.getElementById('question-list');
  if (!list) return;

  list.querySelectorAll('[data-q]').forEach((el) => {
    const index = Number(el.dataset.q);
    if (Number.isNaN(index)) return;
    const q = builder.questions[index];
    if (!q) return;

    if (el.dataset.option !== undefined) {
      el.addEventListener('input', () => {
        q.options[Number(el.dataset.option)].text = el.value;
      });
    } else if (el.dataset.correct !== undefined) {
      el.addEventListener('change', () => {
        q.correctAnswer = Number(el.dataset.correct);
      });
    } else if (el.dataset.type) {
      el.addEventListener('change', () => {
        q.type = el.value;
        if (q.type === 'multiple_choice') {
          q.options = q.options.length ? q.options : [{ text: '' }, { text: '' }];
          q.correctAnswer = 0;
        } else if (q.type === 'true_false') {
          q.correctAnswer = true;
        } else if (q.type === 'short_answer') {
          q.correctAnswer = '';
        } else {
          q.correctAnswer = null;
        }
        renderBuilderQuestions();
      });
    } else if (el.dataset.answer !== undefined) {
      el.addEventListener('input', () => {
        q.correctAnswer = el.value;
      });
      el.addEventListener('change', () => {
        q.correctAnswer = el.value === 'true' ? true : el.value === 'false' ? false : el.value;
      });
    } else if (el.dataset.text !== undefined) {
      el.addEventListener('input', () => {
        q.question = el.value;
      });
    } else if (el.dataset.points !== undefined) {
      el.addEventListener('input', () => {
        q.points = Number(el.value) || 1;
      });
    } else if (el.dataset.difficulty !== undefined) {
      el.addEventListener('change', () => {
        q.difficulty = el.value;
      });
    } else if (el.dataset.explanation !== undefined) {
      el.addEventListener('input', () => {
        q.explanation = el.value;
      });
    }
  });
}

async function submitQuizBuilder(form, publish) {
  const questions = builder.questions.map((q) => {
    const base = {
      type: q.type,
      question: String(q.question || '').trim(),
      points: Number(q.points) || 1,
      difficulty: q.difficulty || 'medium',
      explanation: q.explanation || undefined,
    };

    if (q.type === 'multiple_choice') {
      return {
        ...base,
        options: q.options.map((o) => ({ text: String(o.text || '').trim() })).filter((o) => o.text),
        correctAnswer: Number(q.correctAnswer) || 0,
      };
    }
    if (q.type === 'true_false') return { ...base, correctAnswer: q.correctAnswer === true || q.correctAnswer === 'true' };
    if (q.type === 'short_answer') {
      return { ...base, correctAnswer: String(q.correctAnswer || '').split('|').map((s) => s.trim()).filter(Boolean) };
    }
    return { ...base, correctAnswer: null };
  });

  if (questions.some((q) => !q.question || q.question.length < 3)) {
    throw new ApiError('Every question needs at least 3 characters', { status: 422 });
  }

  const payload = {
    title: form.title.value.trim(),
    description: form.description.value.trim(),
    category: form.category.value,
    difficulty: form.difficulty.value,
    subject: form.subject?.value || null,
    isPublished: publish,
    questions,
    settings: {
      passingScore: Number(form.passingScore.value) || 60,
      timePerQuestion: Number(form.timePerQuestion.value) || 60,
      maxAttempts: Number(form.maxAttempts?.value) || 1,
      randomizeQuestions: form.randomizeQuestions.checked,
      showCorrectAnswers: form.showCorrectAnswers.checked,
      allowRetakes: form.allowRetakes.checked,
    },
  };

  await api('/teacher/quizzes', { method: 'POST', body: payload });
  builder.questions = [];
  toast(publish ? 'Quiz published' : 'Draft saved', { type: 'success' });
  location.hash = '#/studio';
}

/* quiz analytics */

async function viewQuizAnalytics(id) {
  const { data } = await api(`/teacher/quizzes/${id}/analytics`);
  const s = data.summary || {};
  const maxBucket = Math.max(...(data.scoreDistribution || []).map((b) => b.count), 1);

  return layout(
    `<div class="page-head"><div><span class="eyebrow">Analytics</span><h1 style="font-size:clamp(1.7rem,3.6vw,2.3rem)">${esc(data.quiz?.title || 'Quiz')}</h1><p>${esc(data.quiz?.category?.name || 'General')} · ${s.questionCount} questions · ${s.totalPoints} points</p></div><a class="btn btn-ghost" href="#/studio">← Studio</a></div>
     <div class="stat-grid">
       <div class="stat"><div class="stat-label">Attempts</div><div class="stat-value">${s.attempts || 0}</div><div class="stat-foot">Completion ${pct(s.completionRate)}</div></div>
       <div class="stat"><div class="stat-label">Average score</div><div class="stat-value">${pct(s.averageScore)}</div><div class="stat-foot">Pass rate ${pct(s.passRate)}</div></div>
       <div class="stat"><div class="stat-label">Avg time</div><div class="stat-value">${secondsToClock(s.averageTimeSpent)}</div><div class="stat-foot">Per attempt</div></div>
       <div class="stat"><div class="stat-label">Published</div><div class="stat-value">${data.quiz?.isPublished ? 'Live' : 'Draft'}</div><div class="stat-foot">${data.attempts?.length || 0} recent submissions</div></div>
     </div>

     <div class="split section">
       <div class="card">
         <div class="section-head" style="margin-bottom:8px"><h3>Score distribution</h3></div>
         <div class="chart">
           ${(data.scoreDistribution || [])
             .map((b) => `<div class="bar-col"><div class="bar" style="height:${Math.max(3, (b.count / maxBucket) * 100)}%"></div><span>${esc(b.bucket)}</span></div>`)
             .join('')}
         </div>
       </div>
       <div class="card">
         <div class="section-head" style="margin-bottom:12px"><h3>Recent submissions</h3></div>
         ${
           (data.attempts || []).length
             ? data.attempts
                 .slice(0, 6)
                 .map(
                   (a) => `<div class="kv"><span>${esc(a.student?.profile?.firstName || a.student?.username || 'Student')}</span><span><strong>${pct(a.score?.percentage)}</strong> · ${timeAgo(a.completedAt)}</span></div>`,
                 )
                 .join('')
             : '<p class="hint">No submissions yet.</p>'
         }
       </div>
     </div>

     <section class="section">
       <div class="section-head"><h2>Question difficulty</h2><span class="hint">Lowest correct rate first</span></div>
       <div class="table-wrap"><table class="table"><thead><tr><th>Question</th><th>Type</th><th>Attempts</th><th>Correct rate</th><th>Avg points</th></tr></thead><tbody>
         ${(data.questionStats || [])
           .map(
             (q) => `<tr><td class="strong">${esc(q.text)}</td><td>${esc(q.type)}</td><td class="num">${q.attempts}</td>
               <td><div class="inline"><div class="progress" style="width:110px"><i style="width:${q.correctRate}%;background:${q.correctRate < 50 ? 'linear-gradient(90deg,#fb7185,#fbbf24)' : 'var(--gradient)'}"></i></div><span>${pct(q.correctRate)}</span></div></td>
               <td class="num">${q.avgPoints}/${q.maxPoints}</td></tr>`,
           )
           .join('') || '<tr><td colspan="5">No submissions yet.</td></tr>'}
       </tbody></table></div>
     </section>`,
    { active: '#/studio' },
  );
}

/* ── views: admin ───────────────────────────────────────────────────────── */

async function viewAdmin() {
  const [{ data }, users] = await Promise.all([
    api('/admin/dashboard'),
    api('/admin/users?limit=8').catch(() => ({ data: [] })),
  ]);

  const growth = data.users?.growth || [];
  const maxGrowth = Math.max(...growth.map((g) => g.count), 1);

  const userRows = (users.data || [])
    .map(
      (u) => `<tr>
        <td><div class="inline"><span class="avatar" style="width:28px;height:28px;font-size:11px">${esc(initials(u.username))}</span><span class="strong">${esc(u.username)}</span></div></td>
        <td>${esc(u.email)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-danger' : u.role === 'teacher' ? 'badge-soft' : 'badge-muted'}">${esc(u.role)}</span></td>
        <td>${u.isActive ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-muted">Disabled</span>'}</td>
        <td>${timeAgo(u.createdAt)}</td>
        <td><button class="btn btn-ghost btn-sm" data-action="toggle-user" data-id="${esc(u.id)}" data-active="${u.isActive ? 'true' : 'false'}">${u.isActive ? 'Deactivate' : 'Activate'}</button></td>
      </tr>`,
    )
    .join('');

  return layout(
    `<div class="page-head"><div><span class="eyebrow">Administration</span><h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">Platform overview</h1><p>Health, growth and the people behind the platform.</p></div><span class="badge ${data.health?.database === 'connected' ? 'badge-success' : 'badge-danger'}">● ${esc(data.health?.database || 'unknown')}</span></div>

     <div class="stat-grid">
       <div class="stat"><div class="stat-label">Users</div><div class="stat-value">${money(data.users?.total)}</div><div class="stat-foot">+${data.users?.newInRange || 0} in range · ${data.users?.teachers || 0} teachers</div></div>
       <div class="stat"><div class="stat-label">Quizzes</div><div class="stat-value">${money(data.quizzes?.published)}<small> live</small></div><div class="stat-foot">${data.quizzes?.total || 0} total · ${data.quizzes?.featured || 0} featured</div></div>
       <div class="stat"><div class="stat-label">Attempts</div><div class="stat-value">${money(data.results?.completed)}</div><div class="stat-foot">Pass rate ${pct(data.results?.passRate)}</div></div>
       <div class="stat"><div class="stat-label">Average score</div><div class="stat-value">${pct(data.results?.averageScore)}</div><div class="stat-foot">Cache: ${esc(data.health?.cache || 'memory')}</div></div>
     </div>

     <section class="section" style="margin-top:26px">
       <div class="section-head"><h2>Subjects &amp; enrollment</h2><div class="inline" style="gap:12px"><span class="hint">Department-wide · last 30 days</span><a class="btn btn-outline btn-sm" href="/api/admin/reports?type=subjects&amp;format=csv&amp;days=30" download>Export CSV</a></div></div>
       <div class="stat-grid">
         <div class="stat"><div class="stat-label">Subjects</div><div class="stat-value">${data.subjects?.total || 0}</div><div class="stat-foot">${data.subjects?.sections || 0} section${data.subjects?.sections === 1 ? '' : 's'} · ${data.subjects?.rosterEntries || 0} roster seat${data.subjects?.rosterEntries === 1 ? '' : 's'}</div></div>
         <div class="stat"><div class="stat-label">Active enrollments</div><div class="stat-value">${data.subjects?.activeEnrollments || 0}</div><div class="stat-foot">${data.subjects?.uniqueStudents || 0} unique students · ${data.subjects?.pendingEnrollments || 0} pending</div></div>
         <div class="stat"><div class="stat-label">Blocked</div><div class="stat-value">${data.subjects?.blockedEnrollments || 0}</div><div class="stat-foot">Seats held on the roster</div></div>
         <div class="stat"><div class="stat-label">QR codes live</div><div class="stat-value">${data.subjects?.activeQrCodes || 0}</div><div class="stat-foot">${data.subjects?.qrIssuedInRange || 0} issued in range · ${data.subjects?.newEnrollments || 0} new joins</div></div>
       </div>
       ${(data.subjects?.topSubjects || []).length
         ? `<div class="table-wrap" style="margin-top:16px"><table class="table"><thead><tr><th>Subject</th><th>Section</th><th>Teacher</th><th>Enrolled</th><th>Blocked</th><th>QR</th></tr></thead><tbody>
             ${(data.subjects?.topSubjects || []).map((s) => `<tr>
               <td><span class="badge badge-soft">${esc(s.subjectCode)}</span> <span class="strong">${esc(s.subjectName)}</span>${s.program ? `<br /><span class="hint">${esc(s.program)}</span>` : ''}</td>
               <td>${esc(s.section)}</td>
               <td>${esc(s.teacherName)}</td>
               <td class="num">${s.enrolledCount}</td>
               <td class="num">${s.blockedCount}</td>
               <td>${s.qrActive ? '<span class="badge badge-success">Live</span>' : '<span class="badge badge-muted">Off</span>'}</td>
             </tr>`).join('')}
           </tbody></table></div>`
         : '<div class="empty" style="margin-top:16px"><strong>No subjects yet</strong><span>Teachers create subjects and QR enrollment codes from Studio → Subjects.</span></div>'}
     </section>

     <div class="split section">
       <div class="card">
         <div class="section-head" style="margin-bottom:8px"><h3>New users</h3><span class="hint">Last 30 days</span></div>
         ${growth.length
           ? `<div class="chart">${growth
               .slice(-24)
               .map((g) => `<div class="bar-col"><div class="bar" style="height:${Math.max(3, (g.count / maxGrowth) * 100)}%"></div><span>${esc(g._id?.slice(5))}</span></div>`)
               .join('')}</div>`
           : '<p class="hint">No signups in this period.</p>'}
       </div>
       <div class="card">
         <div class="section-head" style="margin-bottom:12px"><h3>Categories</h3><a href="#/studio/new" class="link">Add quiz</a></div>
         ${(data.categories || [])
           .map((c) => `<div class="kv"><span><i class="dot" style="--dot:${esc(c.color)};display:inline-block;margin-right:8px"></i>${esc(c.name)}</span><span><strong>${c.quizzes}</strong> quiz${c.quizzes === 1 ? '' : 'zes'} · ${c.attempts} attempt${c.attempts === 1 ? '' : 's'}</span></div>`)
           .join('') || '<p class="hint">No categories yet.</p>'}
       </div>
     </div>

     <section class="section">
       <div class="section-head"><h2>Users</h2><a href="/api/docs" target="_blank" rel="noopener" class="link">Manage via API →</a></div>
       <div class="table-wrap"><table class="table"><thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>${userRows || '<tr><td colspan="6">No users.</td></tr>'}</tbody></table></div>
     </section>

     <section class="section">
       <div class="section-head"><h2>System</h2></div>
       <div class="card">
         <div class="kv"><span>Uptime</span><span>${secondsToClock(data.health?.uptimeSeconds)}</span></div>
         <div class="kv"><span>Database</span><span>${esc(data.health?.database)}</span></div>
         <div class="kv"><span>Cache driver</span><span>${esc(data.health?.cache)}</span></div>
         <div class="kv"><span>API reference</span><a class="link" href="/api/docs" target="_blank" rel="noopener">/api/docs</a></div>
       </div>
     </section>`,
    { active: '#/admin' },
  );
}

/* ── views: profile ─────────────────────────────────────────────────────── */

async function viewProfile() {
  const u = state.user;
  const notifications = await api('/student/notifications?limit=8').catch(() => ({ data: [] }));

  const notifRows = (notifications.data || [])
    .map(
      (n) => `<div class="review-item" style="border-left:3px solid ${n.isRead ? 'var(--border)' : 'var(--accent)'}">
        <div class="review-head"><strong>${esc(n.title)}</strong><span class="hint">${timeAgo(n.createdAt)}</span></div>
        <p class="hint" style="margin-top:4px">${esc(n.message)}</p>
      </div>`,
    )
    .join('');

  return layout(
    `<div class="page-head"><div><span class="eyebrow">Account</span><h1 style="font-size:clamp(1.8rem,4vw,2.4rem)">${esc(u.profile?.firstName || u.username)}</h1><p>${esc(u.email)} · ${esc(u.role)} account${u.academic?.section ? ` · ${esc(u.academic.section)}` : ''}${u.academic?.studentId ? ` · ID ${esc(u.academic.studentId)}` : ''}${u.academic?.department ? ` · ${esc(u.academic.department)}` : ''}</p></div><span class="badge ${u.emailVerified ? 'badge-success' : 'badge-warn'}">${u.emailVerified ? 'Email verified' : 'Email unverified'}</span></div>

     <div class="split">
       <form class="card form-stack" data-form="update-profile">
         <h3>Profile</h3>
         <div class="form-grid">
           <div class="field"><label for="firstName">First name</label><input class="input" id="firstName" name="firstName" value="${esc(u.profile?.firstName || '')}" /></div>
           <div class="field"><label for="lastName">Last name</label><input class="input" id="lastName" name="lastName" value="${esc(u.profile?.lastName || '')}" /></div>
           <div class="field" style="grid-column:1/-1"><label for="bio">Bio</label><textarea class="textarea" id="bio" name="bio" maxlength="500">${esc(u.profile?.bio || '')}</textarea></div>
           <div class="field"><label for="timezone">Timezone</label><input class="input" id="timezone" name="timezone" value="${esc(u.profile?.timezone || 'UTC')}" /></div>
           <div class="field"><label for="language">Language</label><input class="input" id="language" name="language" value="${esc(u.profile?.language || 'en')}" maxlength="10" /></div>
           ${u.role === 'student'
             ? `<div class="field"><label for="section">Section</label><input class="input" id="section" name="section" value="${esc(u.academic?.section || '')}" maxlength="40" /></div>
                <div class="field"><label for="program">Program</label><input class="input" id="program" name="program" value="${esc(u.academic?.program || '')}" maxlength="80" /></div>
                <div class="field"><label for="yearLevel">Year level</label><input class="input" id="yearLevel" name="yearLevel" value="${esc(u.academic?.yearLevel || '')}" maxlength="20" /></div>`
             : u.role === 'teacher'
               ? `<div class="field"><label for="department">Department</label><input class="input" id="department" name="department" value="${esc(u.academic?.department || '')}" maxlength="80" /></div>`
               : ''}
         </div>
         <label class="check"><input type="checkbox" name="emailNotifications" ${u.preferences?.emailNotifications !== false ? 'checked' : ''} /> Email notifications</label>
         <label class="check"><input type="checkbox" name="showOnLeaderboard" ${u.preferences?.privacy?.showOnLeaderboard !== false ? 'checked' : ''} /> Show me on the leaderboard</label>
         <button class="btn btn-primary" type="submit">Save changes</button>
       </form>

       <div class="stack">
         <form class="card form-stack" data-form="change-password">
           <h3>Password</h3>
           <div class="field"><label for="currentPassword">Current password</label><input class="input" id="currentPassword" name="currentPassword" type="password" autocomplete="current-password" required /></div>
           <div class="field"><label for="newPassword">New password</label><input class="input" id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="8" required /></div>
           <button class="btn btn-outline" type="submit">Update password</button>
         </form>

         <div class="card">
           <div class="row" style="margin-bottom:12px"><h3>Notifications</h3><button class="btn btn-ghost btn-sm" data-action="read-all">Mark all read</button></div>
           <div class="stack" style="gap:8px">${notifRows || '<p class="hint">Nothing here yet.</p>'}</div>
         </div>
       </div>
     </div>`,
    { active: '#/profile' },
  );
}

/* ── dialogs: enrollment, subjects, QR, blocking ────────────────────────── */

let enrollStream = null;
let enrollScanTimer = null;

function stopEnrollCamera() {
  if (enrollScanTimer) {
    clearInterval(enrollScanTimer);
    enrollScanTimer = null;
  }
  if (enrollStream) {
    enrollStream.getTracks().forEach((track) => track.stop());
    enrollStream = null;
  }
}

function closeModal() {
  stopEnrollCamera();
  modalRoot.innerHTML = '';
}

function bindModalClose() {
  modalRoot.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', closeModal));
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (event) => {
    if (event.target.dataset.close) closeModal();
  });
}

async function previewEnrollmentCode(code) {
  const box = document.getElementById('enroll-preview');
  if (!box) return;
  box.innerHTML = '<p class="hint">Checking code…</p>';
  try {
    const { data } = await api('/student/enroll/preview', { method: 'POST', body: { code } });
    const subject = data.subject;
    box.innerHTML = `
      <div class="card tight" style="border-color:var(--border-strong)">
        <div class="row"><span class="badge badge-soft">${esc(subject.subjectCode)}</span><span class="badge badge-muted">${esc(subject.section)}</span></div>
        <strong style="display:block;margin-top:8px">${esc(subject.subjectName)}</strong>
        <span class="hint">${esc(subject.teacherName || 'Faculty')} · ${subject.enrolledCount || 0} enrolled</span>
        ${data.blocked
          ? '<p class="hint" style="margin-top:10px;color:var(--danger)">Your teacher has blocked you from this subject.</p>'
          : data.sectionMismatch
            ? `<p class="hint" style="margin-top:10px;color:var(--danger)">This code is for section ${esc(subject.section)}, but your account is in ${esc(data.studentSection)}. Ask your teacher for your section's code.</p>`
            : data.alreadyEnrolled
              ? '<p class="hint" style="margin-top:10px">You are already enrolled.</p>'
              : data.pendingApproval
                ? '<p class="hint" style="margin-top:10px">Your enrollment is waiting for approval.</p>'
                : `<button class="btn btn-primary btn-block" id="enroll-join" data-code="${esc(code)}" style="margin-top:12px">Join ${esc(subject.subjectCode)} →</button>`}
      </div>`;

    box.querySelector('#enroll-join')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Joining…';
      try {
        await api('/student/enroll', { method: 'POST', body: { code } });
        closeModal();
        toast(`Joined ${subject.subjectCode}`, { type: 'success' });
        router();
      } catch (err) {
        toast(err.message, { type: 'error' });
        button.disabled = false;
        button.textContent = 'Try again';
      }
    });
  } catch (err) {
    box.innerHTML = `<p class="hint" style="color:var(--danger)">${esc(err.message)}</p>`;
  }
}

function openEnrollModal(prefill = '') {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="1">
      <div class="card modal modal-wide" role="dialog" aria-modal="true">
        <div class="row"><h3>Join a subject</h3><button class="btn-icon" data-modal-close aria-label="Close">✕</button></div>
        <p class="hint" style="margin-top:6px">Scan the QR code your teacher shows in class, or type the short code printed under it.</p>
        <div id="scan-box" hidden style="margin-top:14px">
          <video id="scan-video" playsinline muted style="width:100%;border-radius:12px;background:#000"></video>
          <p class="hint" id="scan-hint" style="margin-top:6px">Point the camera at the QR code…</p>
        </div>
        <button class="btn btn-outline btn-block" id="scan-start" style="margin-top:14px">📷 Scan with camera</button>
        <form id="enroll-form" class="form-stack" style="margin-top:14px">
          <div class="field"><label for="enroll-code">Enrollment code or link</label>
            <input class="input" id="enroll-code" name="code" placeholder="K7F2-QX9M" value="${esc(prefill)}" autocomplete="off" required />
          </div>
          <button class="btn btn-primary btn-block" type="submit">Check code</button>
        </form>
        <div id="enroll-preview" style="margin-top:14px"></div>
        <div class="auth-note" style="margin-top:14px">Codes are checked against your section — you cannot join another section's class.</div>
      </div>
    </div>`;

  bindModalClose();

  const form = modalRoot.querySelector('#enroll-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    previewEnrollmentCode(form.code.value.trim());
  });

  modalRoot.querySelector('#scan-start').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!('BarcodeDetector' in window)) {
      toast('Camera QR scanning is not supported in this browser — type the code instead.', { type: 'error' });
      return;
    }
    try {
      const box = modalRoot.querySelector('#scan-box');
      const video = modalRoot.querySelector('#scan-video');
      box.hidden = false;
      button.disabled = true;
      button.textContent = 'Camera on — scanning…';
      enrollStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = enrollStream;
      await video.play();
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      enrollScanTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            const raw = codes[0].rawValue || '';
            stopEnrollCamera();
            modalRoot.querySelector('#scan-box').hidden = true;
            form.code.value = raw;
            previewEnrollmentCode(raw);
          }
        } catch {
          /* a dropped frame is not an error */
        }
      }, 600);
    } catch {
      toast('Could not open the camera. Type the code instead.', { type: 'error' });
      button.disabled = false;
      button.textContent = '📷 Scan with camera';
    }
  });

  if (prefill) previewEnrollmentCode(prefill);
}

async function openSubjectModal() {
  if (!state.categories) {
    state.categories = (await api('/categories').catch(() => ({ data: [] }))).data || [];
  }
  const categories = state.categories || [];
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="1">
      <div class="card modal modal-wide" role="dialog" aria-modal="true">
        <div class="row"><h3>New subject</h3><button class="btn-icon" data-modal-close aria-label="Close">✕</button></div>
        <p class="hint" style="margin-top:6px">Subject codes are unique per section. You can generate the QR code right after creating it.</p>
        <form id="subject-form" class="form-stack" style="margin-top:14px">
          <div class="form-grid">
            <div class="field"><label for="subjectCode">Subject code</label><input class="input" id="subjectCode" name="subjectCode" placeholder="CS101" required maxlength="20" /></div>
            <div class="field"><label for="section">Section</label><input class="input" id="section" name="section" placeholder="BSIT-3A" required maxlength="40" /></div>
            <div class="field" style="grid-column:1/-1"><label for="subjectName">Subject name</label><input class="input" id="subjectName" name="subjectName" placeholder="Programming 1" required maxlength="120" /></div>
            <div class="field"><label for="program">Program</label><input class="input" id="program" name="program" value="BSIT" maxlength="80" /></div>
            <div class="field"><label for="maxStudents">Student limit</label><input class="input" id="maxStudents" name="maxStudents" type="number" min="1" max="500" value="50" /></div>
            <div class="field" style="grid-column:1/-1"><label for="subjectCategory">Category</label>
              <select class="select" id="subjectCategory" name="category"><option value="">— none —</option>${categories.map((c) => `<option value="${esc(c._id || c.id)}">${esc(c.name)}</option>`).join('')}</select>
            </div>
            <div class="field" style="grid-column:1/-1"><label for="description">Description</label><textarea class="textarea" id="description" name="description" maxlength="500" placeholder="What does this subject cover?"></textarea></div>
          </div>
          <label class="check"><input type="checkbox" name="allowQr" checked /> Allow QR enrollment</label>
          <label class="check"><input type="checkbox" name="requireApproval" /> Require my approval before students join</label>
          <button class="btn btn-primary btn-block" type="submit">Create subject →</button>
        </form>
      </div>
    </div>`;

  bindModalClose();
  const form = modalRoot.querySelector('#subject-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Creating…';
    try {
      const { data } = await api('/teacher/subjects', {
        method: 'POST',
        body: {
          subjectCode: form.subjectCode.value.trim(),
          subjectName: form.subjectName.value.trim(),
          section: form.section.value.trim(),
          program: form.program.value.trim(),
          description: form.description.value.trim(),
          category: form.subjectCategory.value || null,
          enrollment: {
            allowQr: form.allowQr.checked,
            requireApproval: form.requireApproval.checked,
            maxStudents: Number(form.maxStudents.value) || 50,
          },
        },
      });
      closeModal();
      toast(`${data.subjectCode} created`, { type: 'success' });
      state.categories = null;
      location.hash = `#/studio/subjects/${data.id || data._id}`;
      router();
    } catch (err) {
      toast(err.message, { type: 'error' });
      button.disabled = false;
      button.textContent = 'Create subject →';
    }
  });
}

async function openQrModal(subjectId) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="1">
      <div class="card modal" role="dialog" aria-modal="true">
        <div class="row"><h3>Enrollment QR</h3><button class="btn-icon" data-modal-close aria-label="Close">✕</button></div>
        <p class="hint" id="qr-status" style="margin-top:8px">Generating a fresh code…</p>
      </div>
    </div>`;
  bindModalClose();

  try {
    const { data } = await api(`/teacher/subjects/${subjectId}/qr`, { method: 'POST', body: {} });
    const modal = modalRoot.querySelector('.modal');
    if (!modal) return;
    modal.innerHTML = `
      <div class="row"><h3>${esc(data.subject.subjectCode)} · ${esc(data.subject.section)}</h3><button class="btn-icon" data-modal-close aria-label="Close">✕</button></div>
      <p class="hint" style="margin-top:6px">Project this in class. Students scan it or type the code below.</p>
      <div class="qr-box"><img src="${esc(data.qrDataUrl)}" alt="Enrollment QR code for ${esc(data.subject.subjectCode)}" /></div>
      <div class="qr-code">${esc(data.code)}</div>
      <div class="qr-url">${esc(data.url)}</div>
      <p class="hint" style="text-align:center">Expires ${new Date(data.expiresAt).toLocaleString()}</p>
      <div class="inline" style="margin-top:14px;justify-content:center">
        <button class="btn btn-outline btn-sm" data-copy="${esc(data.code)}">Copy code</button>
        <a class="btn btn-outline btn-sm" href="${esc(data.qrDataUrl)}" download="${esc(data.subject.subjectCode)}-enroll-qr.png">Download PNG</a>
        <button class="btn btn-ghost btn-sm" data-qr-rotate="${esc(subjectId)}">New code</button>
      </div>`;
    bindModalClose();
    modal.querySelector('[data-copy]')?.addEventListener('click', async (event) => {
      try {
        await navigator.clipboard.writeText(event.currentTarget.dataset.copy);
        toast('Code copied', { type: 'success' });
      } catch {
        toast('Copy failed — select the code manually', { type: 'error' });
      }
    });
    modal.querySelector('[data-qr-rotate]')?.addEventListener('click', () => openQrModal(subjectId));
  } catch (err) {
    const status = modalRoot.querySelector('#qr-status');
    if (status) status.textContent = err.message;
  }
}

function openCategoryModal() {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="1">
      <div class="card modal" role="dialog" aria-modal="true">
        <div class="row"><h3>New category</h3><button class="btn-icon" data-modal-close aria-label="Close">✕</button></div>
        <p class="hint" style="margin-top:6px">Categories organise the catalogue. Yours is shared with the department.</p>
        <form id="category-form" class="form-stack" style="margin-top:14px">
          <div class="field"><label for="categoryName">Name</label><input class="input" id="categoryName" name="name" placeholder="Data Structures" required maxlength="60" /></div>
          <div class="field"><label for="categoryColor">Colour</label><input class="input" id="categoryColor" name="color" type="color" value="#f97316" /></div>
          <button class="btn btn-primary btn-block" type="submit">Add category →</button>
        </form>
      </div>
    </div>`;

  bindModalClose();
  const form = modalRoot.querySelector('#category-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const { data } = await api('/teacher/categories', {
        method: 'POST',
        body: { name: form.name.value.trim(), color: form.color.value },
      });
      builder.categories.push({ _id: data.id || data._id, name: data.name, color: data.color });
      const select = document.getElementById('category');
      if (select) {
        const option = document.createElement('option');
        option.value = data.id || data._id;
        option.textContent = data.name;
        select.appendChild(option);
        select.value = option.value;
      }
      state.categories = null;
      closeModal();
      toast('Category added', { type: 'success' });
    } catch (err) {
      toast(err.message, { type: 'error' });
      button.disabled = false;
    }
  });
}

function openBlockModal({ subjectId, studentId, name }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-close="1">
      <div class="card modal" role="dialog" aria-modal="true">
        <h3>Block ${esc(name)}?</h3>
        <p class="hint" style="margin-top:6px">They keep their previous results but cannot open this subject's quizzes or rejoin with the QR code.</p>
        <div class="field" style="margin-top:14px"><label for="blockReason">Reason (visible to the student)</label>
          <input class="input" id="blockReason" placeholder="e.g. academic integrity review" maxlength="200" />
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-modal-close>Cancel</button>
          <button class="btn btn-danger" id="block-confirm">Block student</button>
        </div>
      </div>
    </div>`;

  bindModalClose();
  modalRoot.querySelector('#block-confirm').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Blocking…';
    try {
      await api(`/teacher/subjects/${subjectId}/students/${studentId}/block`, {
        method: 'POST',
        body: { reason: modalRoot.querySelector('#blockReason').value.trim() },
      });
      closeModal();
      toast(`${name} blocked from this subject`, { type: 'success' });
      router();
    } catch (err) {
      toast(err.message, { type: 'error' });
      button.disabled = false;
      button.textContent = 'Block student';
    }
  });
}

/* ── forbidden / not found ──────────────────────────────────────────────── */

function viewNotice({ title, message, cta = '#/quizzes', ctaLabel = 'Browse quizzes' }) {
  return layout(
    `<div class="empty" style="padding:80px 24px;margin-top:40px">
      <strong style="font-size:1.3rem">${esc(title)}</strong>
      <span>${esc(message)}</span>
      <a class="btn btn-primary" href="${esc(cta)}" style="margin-top:8px">${esc(ctaLabel)}</a>
    </div>`,
    { active: '' },
  );
}

/* ── realtime ───────────────────────────────────────────────────────────── */

function loadSocketClient() {
  if (window.io) return Promise.resolve(window.io);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    script.onload = () => resolve(window.io);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function connectSocket(quizId) {
  try {
    const io = await loadSocketClient();
    if (state.socket) state.socket.disconnect();
    state.socket = io({ withCredentials: true });
    state.socket.on('connect', () => {
      state.socket.emit('quiz:join', { quizId }, (res) => {
        const el = document.getElementById('participants');
        if (el && res?.ok) el.textContent = `◉ ${res.participants || 1} online`;
      });
    });
    state.socket.on('quiz:participants', ({ count }) => {
      const el = document.getElementById('participants');
      if (el) el.textContent = `◉ ${count || 1} online`;
    });
    state.socket.on('quiz:ended', () => {
      const el = document.getElementById('participants');
      if (el) el.textContent = 'Session ended';
    });
  } catch {
    /* realtime is an enhancement — the timer still works from the server deadline */
  }
}

function disconnectSocket() {
  if (state.socket) {
    state.socket.disconnect();
    state.socket = null;
  }
}

/* ── router ─────────────────────────────────────────────────────────────── */

const ROUTES = [
  { pattern: /^\/$/, handler: viewLanding, title: 'CITE BrainCheck — CITE Department assessments' },
  { pattern: /^\/student\/login$/, handler: () => viewAuth('login', 'student'), title: 'Student sign in · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/student\/register$/, handler: () => viewAuth('register', 'student'), title: 'Student registration · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/teacher\/login$/, handler: () => viewAuth('login', 'teacher'), title: 'Teacher sign in · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/teacher\/register$/, handler: () => viewAuth('register', 'teacher'), title: 'Faculty registration · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/admin\/login$/, handler: () => viewAuth('login', 'admin'), title: 'Admin sign in · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/login$/, handler: () => { location.hash = '#/student/login'; return ''; }, title: 'Sign in · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/register$/, handler: () => { location.hash = '#/student/register'; return ''; }, title: 'Register · CITE BrainCheck', guestOnly: true },
  { pattern: /^\/dashboard$/, handler: viewDashboard, title: 'Dashboard · CITE BrainCheck', auth: true },
  { pattern: /^\/subjects$/, handler: viewMySubjects, title: 'My subjects · CITE BrainCheck', auth: true, roles: ['student'] },
  { pattern: /^\/subjects\/([a-f0-9]{24})$/, handler: viewSubject, title: 'Subject · CITE BrainCheck', auth: true, roles: ['student'], params: ['id'] },
  { pattern: /^\/enroll\/?([A-Za-z0-9-]*)$/, handler: (_id, params) => viewEnroll(params.code), title: 'Join a subject · CITE BrainCheck', params: ['code'] },
  { pattern: /^\/quizzes$/, handler: (_id, params) => viewQuizzes(params), title: 'Explore quizzes · CITE BrainCheck' },
  { pattern: /^\/quiz\/([a-f0-9]{24})$/, handler: viewQuizRunner, title: 'Quiz · CITE BrainCheck', auth: true, params: ['id'] },
  { pattern: /^\/results$/, handler: viewResults, title: 'Your results · CITE BrainCheck', auth: true },
  { pattern: /^\/results\/([a-f0-9]{24})$/, handler: viewResult, title: 'Result · CITE BrainCheck', auth: true, params: ['id'] },
  { pattern: /^\/studio$/, handler: viewStudio, title: 'Studio · CITE BrainCheck', roles: ['teacher', 'admin'] },
  { pattern: /^\/studio\/subjects$/, handler: viewStudioSubjects, title: 'Subjects & QR codes · CITE BrainCheck', roles: ['teacher', 'admin'] },
  { pattern: /^\/studio\/subjects\/([a-f0-9]{24})$/, handler: viewSubjectDetail, title: 'Subject roster · CITE BrainCheck', roles: ['teacher', 'admin'], params: ['id'] },
  { pattern: /^\/studio\/new$/, handler: (_id, params) => viewQuizBuilder(params), title: 'Create quiz · CITE BrainCheck', roles: ['teacher', 'admin'] },
  { pattern: /^\/studio\/([a-f0-9]{24})\/analytics$/, handler: viewQuizAnalytics, title: 'Quiz analytics · CITE BrainCheck', roles: ['teacher', 'admin'], params: ['id'] },
  { pattern: /^\/admin$/, handler: viewAdmin, title: 'Admin · CITE BrainCheck', roles: ['admin'] },
  { pattern: /^\/profile$/, handler: viewProfile, title: 'Profile · CITE BrainCheck', auth: true },
];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, queryString] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(queryString || '') };
}

async function router() {
  clearTimers();
  disconnectSocket();
  closeModal();

  const { path, query } = parseHash();
  const route = ROUTES.find((r) => r.pattern.test(path)) || { handler: () => viewNotice({ title: 'Page not found', message: `Nothing lives at ${path}.` }) };

  const match = path.match(route.pattern);
  const params = {};
  (route.params || []).forEach((name, index) => {
    params[name] = match?.[index + 1];
  });
  params.q = query.get('q') || '';
  params.category = query.get('category') || '';
  params.subject = query.get('subject') || '';

  document.title = route.title || 'CITE BrainCheck';

  if (route.auth && !state.user) {
    state.pendingRoute = `${path}${location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : ''}`;
    const teacherArea = path.startsWith('/studio') || path.startsWith('/results');
    const loginRoute = teacherArea ? '#/teacher/login' : '#/student/login';
    app.innerHTML = layout(
      `<div class="empty" style="margin-top:40px"><strong>Sign in to continue</strong><span>This area is for members.</span><a class="btn btn-primary" href="${loginRoute}">Sign in</a></div>`,
      { active: '' },
    );
    return;
  }

  if (route.guestOnly && state.user) {
    location.hash = state.user.role === 'teacher' ? '#/studio' : state.user.role === 'admin' ? '#/admin' : '#/dashboard';
    return;
  }

  if (route.roles && !state.user) {
    state.pendingRoute = `${path}${location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : ''}`;
    location.hash = route.roles.includes('teacher') ? '#/teacher/login' : '#/admin/login';
    return;
  }

  if (route.roles && !route.roles.includes(state.user.role)) {
    const teacherArea = route.roles.includes('teacher');
    app.innerHTML = viewNotice({
      title: 'Restricted area',
      message: teacherArea
        ? 'Teacher accounts create and manage subjects and quizzes.'
        : 'Only administrators can open this page.',
      cta: '#/dashboard',
      ctaLabel: 'Back to dashboard',
    });
    return;
  }

  app.innerHTML = `<div class="shell"><div class="page">${loadingBlock(3)}</div></div>`;

  try {
    const view = await route.handler(params.id, params);
    if (typeof view === 'string') app.innerHTML = view;
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      app.innerHTML = layout(
        `<div class="empty" style="margin-top:40px"><strong>Session expired</strong><span>Please sign in again.</span><a class="btn btn-primary" href="#/login">Sign in</a></div>`,
        { active: '' },
      );
      return;
    }
    console.error(err);
    app.innerHTML = layout(
      `<div class="empty" style="margin-top:40px"><strong>Could not load this page</strong><span>${esc(err.message)}</span><button class="btn btn-outline" data-action="reload">Try again</button></div>`,
      { active: '' },
    );
  }
}

/* ── events ─────────────────────────────────────────────────────────────── */

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();

  const kind = form.dataset.form;

  try {
    if (kind === 'login' || kind === 'register') {
      const values = readForm(form);
      const role = form.dataset.role || 'student';
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = kind === 'login' ? 'Signing in…' : 'Creating account…';

      const body = kind === 'login'
        ? { identifier: values.identifier, password: values.password, expectedRole: role }
        : {
            username: values.username,
            email: values.email,
            password: values.password,
            role,
            profile: { firstName: values.firstName, lastName: values.lastName },
            academic: role === 'student'
              ? {
                  studentId: values.studentId,
                  section: values.section,
                  program: values.program,
                  yearLevel: values.yearLevel,
                }
              : { teacherId: values.teacherId, department: values.department },
          };

      const { data } = await api(`/auth/${kind}`, { method: 'POST', body });
      state.user = data.user;
      toast(`Welcome ${data.user.profile?.firstName || data.user.username}!`, { type: 'success' });
      const home = data.user.role === 'teacher' ? '#/studio' : data.user.role === 'admin' ? '#/admin' : '#/dashboard';
      const next = state.pendingRoute || state.pendingEnroll || home;
      state.pendingRoute = null;
      state.pendingEnroll = null;
      location.hash = next;
      return;
    }

    if (kind === 'search-quizzes') {
      const values = readForm(form);
      const qs = new URLSearchParams();
      if (values.q) qs.set('q', values.q);
      if (state.route.params?.category) qs.set('category', state.route.params.category);
      location.hash = `#/quizzes${qs.toString() ? `?${qs}` : ''}`;
      return;
    }

    if (kind === 'create-quiz') {
      const submitter = event.submitter;
      const publish = submitter?.value !== '1';
      const button = submitter || form.querySelector('button[type="submit"]');
      if (button) {
        button.disabled = true;
        button.dataset.label = button.textContent;
        button.textContent = publish ? 'Publishing…' : 'Saving…';
      }
      try {
        await submitQuizBuilder(form, publish);
      } finally {
        if (button && document.body.contains(button)) {
          button.disabled = false;
          button.textContent = button.dataset.label || 'Save';
        }
      }
      return;
    }

    if (kind === 'update-profile') {
      const values = readForm(form);
      const { data } = await api('/student/profile', {
        method: 'PUT',
        body: {
          profile: {
            firstName: values.firstName,
            lastName: values.lastName,
            bio: values.bio,
            timezone: values.timezone,
            language: values.language,
          },
          academic: {
            ...(form.section ? { section: form.section.value } : {}),
            ...(form.program ? { program: form.program.value } : {}),
            ...(form.yearLevel ? { yearLevel: form.yearLevel.value } : {}),
            ...(form.department ? { department: form.department.value } : {}),
          },
          preferences: {
            emailNotifications: form.emailNotifications.checked,
            privacy: { showOnLeaderboard: form.showOnLeaderboard.checked },
          },
        },
      });
      state.user = data;
      toast('Profile updated', { type: 'success' });
      router();
      return;
    }

    if (kind === 'change-password') {
      const values = readForm(form);
      await api('/auth/password', {
        method: 'PATCH',
        body: { currentPassword: values.currentPassword, newPassword: values.newPassword },
      });
      form.reset();
      toast('Password updated', { type: 'success' });
    }
  } catch (err) {
    toast(err.message, { type: 'error' });
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = false;
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  const menu = document.getElementById('user-menu');
  if (menu && !event.target.closest('.menu')) menu.classList.remove('open');

  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'toggle-menu': {
      event.stopPropagation();
      document.getElementById('user-menu')?.classList.toggle('open');
      break;
    }

    case 'logout': {
      await api('/auth/logout', { method: 'POST', body: {} }).catch(() => {});
      state.user = null;
      state.socket?.disconnect();
      toast('Signed out', { type: 'success' });
      location.hash = '#/';
      break;
    }

    case 'enroll-open': {
      openEnrollModal();
      break;
    }

    case 'enroll-confirm': {
      target.disabled = true;
      target.textContent = 'Joining…';
      try {
        const { data } = await api('/student/enroll', { method: 'POST', body: { code: target.dataset.code } });
        toast(data.pendingApproval ? 'Enrollment sent for approval' : `Joined ${data.subject.subjectCode}`, { type: 'success' });
        location.hash = data.subject?.id ? `#/subjects/${data.subject.id}` : '#/subjects';
      } catch (err) {
        toast(err.message, { type: 'error' });
        target.disabled = false;
        target.textContent = 'Try again';
      }
      break;
    }

    case 'subject-new': {
      openSubjectModal();
      break;
    }

    case 'subject-qr': {
      openQrModal(target.dataset.id);
      break;
    }

    case 'category-new': {
      openCategoryModal();
      break;
    }

    case 'student-block': {
      openBlockModal({ subjectId: target.dataset.subject, studentId: target.dataset.student, name: target.dataset.name });
      break;
    }

    case 'student-unblock': {
      try {
        await api(`/teacher/subjects/${target.dataset.subject}/students/${target.dataset.student}/block`, { method: 'DELETE' });
        toast('Student unblocked', { type: 'success' });
        router();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
      break;
    }

    case 'student-remove': {
      if (!(await confirmDialog({
        title: `Remove ${target.dataset.name}?`,
        message: 'They can rejoin later with a valid QR code. Their results stay in the gradebook.',
        confirmLabel: 'Remove',
        danger: true,
      }))) break;
      try {
        await api(`/teacher/subjects/${target.dataset.subject}/students/${target.dataset.student}`, { method: 'DELETE' });
        toast('Student removed', { type: 'success' });
        router();
      } catch (err) {
        toast(err.message, { type: 'error' });
      }
      break;
    }

    case 'filter-category': {
      const qs = new URLSearchParams();
      if (target.dataset.id) qs.set('category', target.dataset.id);
      location.hash = `#/quizzes${qs.toString() ? `?${qs}` : ''}`;
      break;
    }

    case 'prev-question': {
      if (!state.runner) break;
      state.runner.index = Math.max(0, state.runner.index - 1);
      renderQuestion();
      break;
    }

    case 'next-question': {
      if (!state.runner) break;
      state.runner.index = Math.min(state.runner.quiz.questions.length - 1, state.runner.index + 1);
      renderQuestion();
      break;
    }

    case 'goto-question': {
      if (!state.runner) break;
      state.runner.index = Number(target.dataset.index) || 0;
      renderQuestion();
      break;
    }

    case 'submit-quiz': {
      submitQuiz();
      break;
    }

    case 'add-question': {
      builder.questions.push(emptyQuestion());
      renderBuilderQuestions();
      break;
    }

    case 'remove-question': {
      builder.questions.splice(Number(target.dataset.q), 1);
      if (!builder.questions.length) builder.questions.push(emptyQuestion());
      renderBuilderQuestions();
      break;
    }

    case 'add-option': {
      const q = builder.questions[Number(target.dataset.q)];
      if (q && q.options.length < 8) {
        q.options.push({ text: '' });
        renderBuilderQuestions();
      }
      break;
    }

    case 'remove-option': {
      const q = builder.questions[Number(target.dataset.q)];
      if (q && q.options.length > 2) {
        q.options.splice(Number(target.dataset.option), 1);
        if (Number(q.correctAnswer) >= q.options.length) q.correctAnswer = 0;
        renderBuilderQuestions();
      }
      break;
    }

    case 'reload': {
      router();
      break;
    }

    case 'read-all': {
      await api('/student/notifications/read-all', { method: 'PATCH' }).catch(() => {});
      toast('Notifications cleared', { type: 'success' });
      router();
      break;
    }

    case 'notifications': {
      const { data } = await api('/student/notifications?limit=6').catch(() => ({ data: [] }));
      if (!data?.length) {
        toast('No notifications yet', { title: 'Inbox' });
        break;
      }
      modalRoot.innerHTML = `<div class="modal-backdrop" data-close="1">
        <div class="card modal">
          <div class="row"><h3>Notifications</h3><button class="btn btn-ghost btn-sm" data-modal-action="close">Close</button></div>
          <div class="stack" style="margin-top:14px">
            ${data
              .map(
                (n) => `<div class="review-item" style="border-left:3px solid ${n.isRead ? 'var(--border)' : 'var(--accent)'}">
                  <div class="review-head"><strong>${esc(n.title)}</strong><span class="hint">${timeAgo(n.createdAt)}</span></div>
                  <p class="hint" style="margin-top:4px">${esc(n.message)}</p>
                </div>`,
              )
              .join('')}
          </div>
        </div>
      </div>`;
      modalRoot.querySelector('[data-modal-action="close"]')?.addEventListener('click', () => {
        modalRoot.innerHTML = '';
      });
      modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
        if (e.target.dataset.close) modalRoot.innerHTML = '';
      });
      break;
    }

    case 'toggle-publish': {
      const published = target.dataset.published === 'true';
      const { data } = await api(`/teacher/quizzes/${target.dataset.id}/publish`, {
        method: 'POST',
        body: { isPublished: !published },
      }).catch((err) => {
        toast(err.message, { type: 'error' });
        return { data: null };
      });
      if (data) {
        toast(data.isPublished ? 'Quiz published' : 'Quiz unpublished', { type: 'success' });
        router();
      }
      break;
    }

    case 'toggle-user': {
      const active = target.dataset.active === 'true';
      const { data } = await api(`/admin/users/${target.dataset.id}`, {
        method: 'PATCH',
        body: { isActive: !active },
      }).catch((err) => {
        toast(err.message, { type: 'error' });
        return { data: null };
      });
      if (data) {
        toast(data.isActive ? 'User activated' : 'User deactivated', { type: 'success' });
        router();
      }
      break;
    }

    default:
      break;
  }
});

window.addEventListener('hashchange', router);

/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  const [me, config] = await Promise.all([
    api('/auth/me').catch(() => null),
    api('/config').catch(() => null),
  ]);
  state.user = me?.data || null;
  state.config = config?.data || null;

  if (!location.hash) location.hash = '#/';
  await router();
}

boot();
