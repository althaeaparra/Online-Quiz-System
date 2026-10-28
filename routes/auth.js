import { Router } from 'express';
import * as auth from '../controllers/authController.js';
import { validate } from '../middleware/validation.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter, writeLimiter } from '../middleware/rateLimit.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  changePasswordSchema,
} from '../utils/validators.js';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), auth.register);
router.post('/login', authLimiter, validate(loginSchema), auth.login);
router.post('/refresh', validate(refreshSchema), auth.refresh);
router.post('/logout', auth.logout);

router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), auth.forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), auth.resetPassword);
router.post('/verify-email', authLimiter, validate(verifyEmailSchema), auth.verifyEmail);
router.post('/resend-verification', authenticate, authLimiter, auth.resendVerification);

router.get('/me', authenticate, auth.me);
router.patch('/password', authenticate, writeLimiter, validate(changePasswordSchema), auth.changePassword);

export default router;
