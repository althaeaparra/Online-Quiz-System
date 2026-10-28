import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { COOKIE_NAMES, TOKEN_TYPES } from '../config/constants.js';
import { durationToSeconds } from './helpers.js';
import cache from './cache.js';
import { UnauthorizedError } from './errors.js';

const ACCESS_SECRET = () => process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me';
const REFRESH_SECRET = () => process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me';
const ACCESS_TTL = () => process.env.JWT_ACCESS_EXPIRES || '15m';
const REFRESH_TTL = () => process.env.JWT_REFRESH_EXPIRES || '7d';

const sessionKey = (userId) => `sessions:${userId}`;

export function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      username: user.username,
      type: TOKEN_TYPES.ACCESS,
    },
    ACCESS_SECRET(),
    { expiresIn: ACCESS_TTL(), issuer: 'citebraincheck', audience: 'citebraincheck-client' },
  );
}

export function signRefreshToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: user._id.toString(), type: TOKEN_TYPES.REFRESH, jti },
    REFRESH_SECRET(),
    { expiresIn: REFRESH_TTL(), issuer: 'citebraincheck', audience: 'citebraincheck-client' },
  );
  return { token, jti };
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, ACCESS_SECRET(), { issuer: 'citebraincheck', audience: 'citebraincheck-client' });
    if (payload.type !== TOKEN_TYPES.ACCESS) throw new Error('Wrong token type');
    return payload;
  } catch (err) {
    throw new UnauthorizedError(
      err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token',
    );
  }
}

export function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, REFRESH_SECRET(), { issuer: 'citebraincheck', audience: 'citebraincheck-client' });
    if (payload.type !== TOKEN_TYPES.REFRESH) throw new Error('Wrong token type');
    return payload;
  } catch (err) {
    throw new UnauthorizedError(
      err.name === 'TokenExpiredError' ? 'Refresh token expired, please sign in again' : 'Invalid refresh token',
    );
  }
}

/** Track issued refresh-token ids so sessions can be revoked / rotated. */
export async function registerSession(userId, jti) {
  await cache.sAdd(sessionKey(userId), jti);
  await cache.expire(sessionKey(userId), durationToSeconds(REFRESH_TTL(), 604800));
}

export async function isSessionActive(userId, jti) {
  const sessions = await cache.sMembers(sessionKey(userId));
  // An empty set means the store was flushed (e.g. server restart without
  // Redis); treat the signed token itself as the source of truth then.
  if (!sessions.length) return true;
  return sessions.includes(jti);
}

export async function revokeSession(userId, jti) {
  if (!jti) return;
  await cache.sRem(sessionKey(userId), jti);
}

export async function revokeAllSessions(userId) {
  await cache.del(sessionKey(userId));
}

export async function issueTokens(user, { jti: previousJti } = {}) {
  const accessToken = signAccessToken(user);
  const { token: refreshToken, jti } = signRefreshToken(user);
  if (previousJti) await revokeSession(user._id.toString(), previousJti);
  await registerSession(user._id.toString(), jti);
  return { accessToken, refreshToken, jti };
}

/**
 * Cookie flags.
 *
 * `COOKIE_SECURE` wins over the environment default, so a plain-HTTP internal
 * deployment can turn the Secure flag off instead of silently losing every
 * session cookie. SameSite defaults to Lax, which is correct for a SPA served
 * by this API and blocks cross-site form posts; a genuinely cross-site
 * front-end needs COOKIE_SAME_SITE=none together with Secure cookies.
 */
const cookieBase = () => {
  const production = process.env.NODE_ENV === 'production';
  const secure = process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : production;
  const sameSite = process.env.COOKIE_SAME_SITE || 'lax';

  return {
    httpOnly: true,
    sameSite,
    secure,
    ...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
    path: '/',
  };
};

export function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(COOKIE_NAMES.ACCESS, accessToken, {
    ...cookieBase(),
    maxAge: durationToSeconds(ACCESS_TTL(), 900) * 1000,
  });
  res.cookie(COOKIE_NAMES.REFRESH, refreshToken, {
    ...cookieBase(),
    maxAge: durationToSeconds(REFRESH_TTL(), 604800) * 1000,
  });
}

export function clearAuthCookies(res) {
  res.clearCookie(COOKIE_NAMES.ACCESS, cookieBase());
  res.clearCookie(COOKIE_NAMES.REFRESH, cookieBase());
}

export default {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  issueTokens,
  registerSession,
  isSessionActive,
  revokeSession,
  revokeAllSessions,
  setAuthCookies,
  clearAuthCookies,
};
