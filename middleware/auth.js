import { User } from '../models/User.js';
import { COOKIE_NAMES, ROLES } from '../config/constants.js';
import { verifyAccessToken } from '../utils/tokens.js';
import { ForbiddenError, UnauthorizedError } from '../utils/errors.js';
import { asyncHandler } from '../utils/errors.js';

/**
 * Extract a bearer token from the Authorization header, or from the httpOnly
 * cookie set by the login endpoint. The cookie keeps the SPA XSS-safe: JS never
 * touches the token.
 */
export function extractAccessToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return req.cookies?.[COOKIE_NAMES.ACCESS] || null;
}

async function resolveUser(token) {
  const payload = verifyAccessToken(token);
  const user = await User.findById(payload.sub).select('+security').lean({ virtuals: false });
  if (!user) throw new UnauthorizedError('This account no longer exists');
  if (user.security?.isActive === false) throw new ForbiddenError('This account has been deactivated');
  if (user.security?.lockUntil && new Date(user.security.lockUntil) > new Date()) {
    throw new ForbiddenError('Account temporarily locked, try again later');
  }
  return user;
}

export const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractAccessToken(req);
  if (!token) throw new UnauthorizedError('Sign in to continue');

  const user = await resolveUser(token);
  req.user = user;
  req.userId = user._id.toString();
  return next();
});

/** Same as authenticate but never rejects — used for public endpoints. */
export const optionalAuth = async (req, _res, next) => {
  const token = extractAccessToken(req);
  if (!token) return next();
  try {
    req.user = await resolveUser(token);
    req.userId = req.user._id.toString();
  } catch {
    /* anonymous access is fine here */
  }
  return next();
};

/** Role-based access control. Admins implicitly pass every gate. */
export const roleMiddleware =
  (...roles) =>
  (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError('Sign in to continue'));
    const allowed = roles.flat();
    if (allowed.length === 0 || req.user.role === ROLES.ADMIN || allowed.includes(req.user.role)) {
      return next();
    }
    return next(new ForbiddenError(`This area is restricted to ${allowed.join(', ')} accounts`));
  };

/** Alias used by routes — reads a bit better at call sites. */
export const authorize = roleMiddleware;

/**
 * Ownership gate: resolves the owner id of the resource via a loader and lets
 * admins through regardless.
 */
export const ownershipMiddleware =
  (loader, { ownerField = 'teacher', resourceName = 'Resource' } = {}) =>
  asyncHandler(async (req, _res, next) => {
    if (!req.user) throw new UnauthorizedError('Sign in to continue');
    if (req.user.role === ROLES.ADMIN) return next();

    const resource = await loader(req);
    if (!resource) {
      const { NotFoundError } = await import('../utils/errors.js');
      throw new NotFoundError(resourceName);
    }
    const ownerId = (resource[ownerField]?._id || resource[ownerField] || resource._id).toString();
    if (ownerId !== req.user._id.toString()) {
      throw new ForbiddenError(`You do not own this ${resourceName.toLowerCase()}`);
    }
    req.resource = resource;
    return next();
  });

export default { authenticate, optionalAuth, authorize, roleMiddleware, ownershipMiddleware, extractAccessToken };
