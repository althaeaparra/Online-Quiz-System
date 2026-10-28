import { User } from '../models/User.js';
import { ROLES } from '../config/constants.js';
import { asyncHandler, ConflictError, UnauthorizedError, ForbiddenError, ValidationError } from '../utils/errors.js';
import { publicUser } from '../utils/helpers.js';
import { ok, created } from '../utils/response.js';
import {
  issueTokens,
  verifyRefreshToken,
  isSessionActive,
  revokeSession,
  revokeAllSessions,
  setAuthCookies,
  clearAuthCookies,
} from '../utils/tokens.js';
import { sendWelcomeEmail, sendVerificationEmail, sendPasswordResetEmail } from '../services/emailService.js';
import logger from '../utils/logger.js';

const MAX_FAILED_LOGINS = 5;

const authPayload = (user, tokens) => ({
  user: publicUser(user),
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
});

/** POST /api/auth/register */
export const register = asyncHandler(async (req, res) => {
  const { username, email, password, role, academic = {}, profile = {} } = req.body;

  const existing = await User.findOne({ $or: [{ email }, { username }] }).select('email username');
  if (existing) {
    throw new ConflictError(
      existing.email === email ? 'An account with this email already exists' : 'That username is taken',
    );
  }

  // One student number / employee number may only back a single account.
  if (role === ROLES.STUDENT && academic.studentId) {
    const taken = await User.findOne({ 'academic.studentId': academic.studentId.toUpperCase() }).select('_id');
    if (taken) throw new ConflictError('That student ID is already registered');
  }
  if (role === ROLES.TEACHER && academic.teacherId) {
    const taken = await User.findOne({ 'academic.teacherId': academic.teacherId.toUpperCase() }).select('_id');
    if (taken) throw new ConflictError('That teacher ID is already registered');
  }

  const user = new User({
    username,
    email,
    password,
    role,
    profile,
    academic: role === ROLES.STUDENT
      ? {
          studentId: academic.studentId,
          section: academic.section,
          program: academic.program || 'BSIT',
          yearLevel: academic.yearLevel || '',
          department: 'CITE',
        }
      : {
          teacherId: academic.teacherId,
          department: academic.department || 'CITE',
        },
  });

  const verificationToken = user.createVerificationToken();
  await user.save();

  // Emails are best-effort; a mail outage must not block sign-up.
  await Promise.allSettled([sendWelcomeEmail(user), sendVerificationEmail(user, verificationToken)]);

  const tokens = await issueTokens(user);
  setAuthCookies(res, tokens);

  return created(res, authPayload(user, tokens));
});

/** POST /api/auth/login */
export const login = asyncHandler(async (req, res) => {
  const identifier = (req.body.identifier || req.body.email || req.body.username || '').trim();
  const { password, expectedRole } = req.body;

  const user = await User.findOne({
    $or: [{ email: identifier.toLowerCase() }, { username: identifier }],
  }).select('+password +security');

  if (!user) throw new UnauthorizedError('Incorrect email or password');

  if (user.security?.lockUntil && user.security.lockUntil > new Date()) {
    const minutes = Math.ceil((user.security.lockUntil - Date.now()) / 60000);
    throw new ForbiddenError(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
  }

  if (user.security?.isActive === false) throw new ForbiddenError('This account has been deactivated');

  // Portal separation: a student account cannot sign in through the teacher
  // door (or vice versa), even with correct credentials.
  if (expectedRole && user.role !== expectedRole) {
    const portal = expectedRole === ROLES.TEACHER ? 'teacher' : expectedRole === ROLES.STUDENT ? 'student' : expectedRole;
    throw new ForbiddenError(`This is the ${portal} sign-in page. Use the ${user.role} portal for this account.`);
  }

  const matches = await user.comparePassword(password);
  if (!matches) {
    if (user.security.loginAttempts + 1 >= MAX_FAILED_LOGINS) {
      user.security.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
      user.security.loginAttempts = 0;
    } else {
      user.security.loginAttempts += 1;
    }
    await user.save();
    throw new UnauthorizedError('Incorrect email or password');
  }

  user.security.loginAttempts = 0;
  user.security.lockUntil = null;
  user.lastLogin = new Date();
  await user.save();

  const tokens = await issueTokens(user);
  setAuthCookies(res, tokens);

  return ok(res, authPayload(user, tokens));
});

/** POST /api/auth/refresh — rotates the refresh token. */
export const refresh = asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken || req.cookies?.qf_refresh;
  if (!token) throw new UnauthorizedError('No refresh token provided');

  const payload = verifyRefreshToken(token);
  const active = await isSessionActive(payload.sub, payload.jti);
  if (!active) throw new UnauthorizedError('Session expired, please sign in again');

  const user = await User.findById(payload.sub).select('+security');
  if (!user || user.security?.isActive === false) throw new UnauthorizedError('Account unavailable');

  const tokens = await issueTokens(user, { jti: payload.jti });
  setAuthCookies(res, tokens);

  return ok(res, authPayload(user, tokens));
});

/** POST /api/auth/logout */
export const logout = asyncHandler(async (req, res) => {
  const token = req.body?.refreshToken || req.cookies?.qf_refresh;
  if (token) {
    try {
      const payload = verifyRefreshToken(token);
      await revokeSession(payload.sub, payload.jti);
    } catch {
      /* logging out with an expired token is fine */
    }
  }
  clearAuthCookies(res);
  return ok(res, { message: 'Signed out' });
});

/** GET /api/auth/me */
export const me = asyncHandler(async (req, res) => ok(res, publicUser(req.user)));

/** POST /api/auth/forgot-password — always generic to avoid account enumeration. */
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await User.findOne({ email, 'security.isActive': true }).select('+security');

  if (user) {
    const token = user.createPasswordResetToken();
    await user.save();
    await sendPasswordResetEmail(user, token);
    logger.info(`Password reset requested for ${user.email}`);
  }

  return ok(res, {
    message: 'If an account exists for that email, a reset link is on its way.',
  });
});

/** POST /api/auth/reset-password */
export const resetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;
  const hashed = User.hashToken(token);

  const user = await User.findOne({
    'security.resetToken': hashed,
    'security.resetExpires': { $gt: new Date() },
  }).select('+security');

  if (!user) throw new ValidationError('This reset link is invalid or has expired');

  user.password = password;
  user.security.resetToken = null;
  user.security.resetExpires = null;
  user.security.loginAttempts = 0;
  user.security.lockUntil = null;
  await user.save();

  await revokeAllSessions(user._id.toString());
  clearAuthCookies(res);

  return ok(res, { message: 'Password updated — sign in with your new password.' });
});

/** POST /api/auth/verify-email */
export const verifyEmail = asyncHandler(async (req, res) => {
  const hashed = User.hashToken(req.body.token);
  const user = await User.findOne({
    'security.verificationToken': hashed,
    'security.verificationExpires': { $gt: new Date() },
  }).select('+security');

  if (!user) throw new ValidationError('This verification link is invalid or has expired');

  user.security.emailVerified = true;
  user.security.verificationToken = null;
  user.security.verificationExpires = null;
  await user.save();

  return ok(res, { message: 'Email verified', user: publicUser(user) });
});

/** POST /api/auth/resend-verification */
export const resendVerification = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('+security');
  if (user.security.emailVerified) {
    return ok(res, { message: 'Email is already verified' });
  }
  const token = user.createVerificationToken();
  await user.save();
  await sendVerificationEmail(user, token);
  return ok(res, { message: 'Verification email sent' });
});

/** PATCH /api/auth/password */
export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password +security');
  if (!user) throw new UnauthorizedError('Account not found');

  const matches = await user.comparePassword(currentPassword);
  if (!matches) throw new ValidationError('Current password is incorrect');

  user.password = newPassword;
  await user.save();

  await revokeAllSessions(user._id.toString());
  const tokens = await issueTokens(user);
  setAuthCookies(res, tokens);

  return ok(res, { message: 'Password changed', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
});

export default {
  register,
  login,
  refresh,
  logout,
  me,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  changePassword,
};
