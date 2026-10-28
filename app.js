import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import routes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { httpLogStream, logger } from './utils/logger.js';
import { getMongoStatus } from './config/db.js';
import { ok } from './utils/response.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

/* ── security & platform middleware ─────────────────────────────────────── */

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

const isProduction = process.env.NODE_ENV === 'production';

/**
 * The SPA is served by this API, so its own origin is always allowed. Extra
 * origins — a separate front-end, a preview domain — come from CORS_ORIGINS,
 * APP_URL and CLIENT_URL. Anything else is refused: the API sends cookies, so
 * an open allowlist would let any site make credentialed calls.
 */
const allowedOrigins = [
  ...(process.env.CORS_ORIGINS || '').split(','),
  process.env.APP_URL,
  process.env.CLIENT_URL,
]
  .map((origin) => (origin || '').trim().replace(/\/$/, ''))
  .filter(Boolean);

const corsOptions = {
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
};

app.use(
  cors((req, callback) => {
    const origin = (req.headers.origin || '').replace(/\/$/, '');
    // Same-origin and non-browser clients send no Origin header.
    if (!origin) return callback(null, { ...corsOptions, origin: true });

    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch {
      sameHost = false;
    }

    const localTooling = !isProduction && /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
    const allowed = sameHost || localTooling || allowedOrigins.includes(origin);

    // origin:false omits the CORS headers, so the browser blocks the response
    // while the request itself is still answered normally.
    return callback(null, { ...corsOptions, origin: allowed });
  }),
);

app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

if (!isProduction && !allowedOrigins.length) {
  logger.warn('CORS_ORIGINS/APP_URL unset — only same-origin and localhost browser requests are allowed.');
}

if (process.env.NODE_ENV !== 'test') {
  app.use(
    morgan(isProduction ? 'combined' : 'dev', {
      stream: httpLogStream,
      skip: (req) => req.path === '/health',
    }),
  );
}

/* ── static assets ──────────────────────────────────────────────────────── */

app.use(
  '/uploads',
  express.static(path.join(__dirname, process.env.UPLOAD_DIR || 'public/uploads'), {
    maxAge: '7d',
    fallthrough: true,
  }),
);

app.use(
  express.static(path.join(__dirname, 'public'), {
    extensions: ['html'],
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }),
);

/* ── health & API ───────────────────────────────────────────────────────── */

app.get('/health', (_req, res) => {
  const db = getMongoStatus();
  const healthy = db.state === 'connected';
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    data: {
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round(process.uptime()),
      database: db.state,
      environment: process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    },
  });
});

app.use('/api', apiLimiter, routes);

// Unknown API routes must return JSON, never the SPA shell.
app.all('/api/*', notFoundHandler);

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
