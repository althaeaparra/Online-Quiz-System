import cache from '../utils/cache.js';
import { TooManyRequestsError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Redis-backed sliding counter limiter. Falls back to the in-process store when
 * Redis is unavailable, so limits still hold per instance in development.
 */
export const rateLimit = ({
  windowMs = 15 * 60 * 1000,
  max = 300,
  prefix = 'rl:global',
  keyGenerator = (req) => req.user?._id?.toString() || req.ip,
  message = 'Too many requests, please slow down',
  skip = () => false,
} = {}) => async (req, res, next) => {
  if (process.env.NODE_ENV === 'test' || skip(req)) return next();

  const windowSeconds = Math.ceil(windowMs / 1000);
  const bucket = Math.floor(Date.now() / windowMs);
  const key = `${prefix}:${keyGenerator(req)}:${bucket}`;

  try {
    const hits = await cache.incr(key, windowSeconds);
    const remaining = Math.max(0, max - hits);
    const resetSeconds = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (hits > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      throw new TooManyRequestsError(message, resetSeconds);
    }
    return next();
  } catch (err) {
    if (err instanceof TooManyRequestsError) return next(err);
    // A cache outage must not take the API down.
    logger.warn(`Rate limiter degraded: ${err.message}`);
    return next();
  }
};

export const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  prefix: 'rl:api',
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  prefix: 'rl:auth',
  keyGenerator: (req) => `${req.ip}:${(req.body?.email || req.body?.identifier || 'anon').toLowerCase()}`,
  message: 'Too many authentication attempts. Try again in a few minutes.',
});

export const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  prefix: 'rl:write',
  message: 'You are submitting too quickly. Please wait a moment.',
});

export default { rateLimit, apiLimiter, authLimiter, writeLimiter };
