import { Router } from 'express';
import { openApiSpec } from '../docs/openapi.js';

const router = Router();

router.get('/openapi.json', (_req, res) => res.json(openApiSpec));

const METHOD_ORDER = ['get', 'post', 'patch', 'put', 'delete'];

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function renderEndpoints() {
  const groups = new Map();

  for (const [path, methods] of Object.entries(openApiSpec.paths)) {
    for (const method of METHOD_ORDER) {
      const op = methods[method];
      if (!op) continue;
      const tag = op.tags?.[0] || 'General';
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push({ path, method, ...op });
    }
  }

  const tagOrder = openApiSpec.tags.map((t) => t.name);
  const sorted = [...groups.entries()].sort(
    (a, b) => tagOrder.indexOf(a[0]) - tagOrder.indexOf(b[0]),
  );

  return sorted
    .map(
      ([tag, ops]) => `
      <section class="doc-group" data-group="${escapeHtml(tag.toLowerCase())}">
        <div class="group-head">
          <h2>${escapeHtml(tag)}</h2>
          <span class="count">${ops.length}</span>
        </div>
        <div class="endpoints">
          ${ops
            .map(
              (op) => `
            <article class="endpoint" data-search="${escapeHtml(`${op.method} ${op.path} ${op.summary}`.toLowerCase())}">
              <div class="endpoint-main">
                <span class="method method-${op.method}">${op.method.toUpperCase()}</span>
                <code>/api${escapeHtml(op.path.replace(/^\//, '/'))}</code>
                <p>${escapeHtml(op.summary || '')}</p>
              </div>
              <button class="copy" data-copy="${escapeHtml(`${op.method.toUpperCase()} /api${op.path}`)}" title="Copy request line">Copy</button>
            </article>`,
            )
            .join('')}
        </div>
      </section>`,
    )
    .join('');
}

router.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CITE BrainCheck — API Reference</title>
<link rel="stylesheet" href="/assets/css/docs.css" />
</head>
<body>
  <div class="aurora" aria-hidden="true"></div>
  <header class="topbar">
    <a class="brand" href="/">
      <span class="logo">Q</span>
      <span>CITE BrainCheck <em>API</em></span>
    </a>
    <div class="topbar-actions">
      <a class="ghost" href="/">Open app</a>
      <a class="solid" href="/api/docs/openapi.json">openapi.json</a>
    </div>
  </header>

  <main class="layout">
    <aside class="sidebar">
      <label class="search">
        <span>Search</span>
        <input id="search" type="search" placeholder="Filter endpoints…" autocomplete="off" />
      </label>
      <div class="side-meta">
        <div><strong>${Object.keys(openApiSpec.paths).length}</strong> paths</div>
        <div><strong>${openApiSpec.tags.length}</strong> groups</div>
        <div><strong>v${openApiSpec.info.version}</strong> version</div>
      </div>
      <nav id="nav"></nav>
    </aside>

    <div class="content">
      <section class="hero">
        <div class="pill">OpenAPI 3.1</div>
        <h1>Build against a quiz API that behaves.</h1>
        <p>${escapeHtml(openApiSpec.info.description)}</p>
        <div class="hero-actions">
          <code class="base">Base URL <strong>/api</strong></code>
          <span class="hint">Auth via <code>qf_access</code> cookie or <code>Authorization: Bearer</code></span>
        </div>
      </section>
      ${renderEndpoints()}
      <footer class="doc-footer">
        Generated from the live spec — errors use <code>{ success: false, error: { code, message } }</code>.
      </footer>
    </div>
  </main>

<script>
  const search = document.getElementById('search');
  const nav = document.getElementById('nav');
  const groups = [...document.querySelectorAll('.doc-group')];

  nav.innerHTML = groups
    .map((g) => {
      const name = g.querySelector('h2').textContent;
      return '<a href="#' + name.toLowerCase().replace(/\\s+/g, '-') + '">' + name + '</a>';
    })
    .join('');

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    groups.forEach((group) => {
      let visible = 0;
      group.querySelectorAll('.endpoint').forEach((row) => {
        const match = !q || row.dataset.search.includes(q);
        row.hidden = !match;
        if (match) visible += 1;
      });
      group.hidden = visible === 0;
    });
  });

  document.addEventListener('click', async (event) => {
    const btn = event.target.closest('.copy');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = original; }, 1200);
    } catch {
      btn.textContent = 'Ctrl+C';
    }
  });
</script>
</body>
</html>`);
});

export default router;
