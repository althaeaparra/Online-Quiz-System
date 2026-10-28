import { Router } from 'express';
import * as admin from '../controllers/adminController.js';
import * as quiz from '../controllers/quizController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { ROLES } from '../config/constants.js';
import {
  adminUpdateUserSchema,
  categorySchema,
  updateCategorySchema,
  userListQuerySchema,
} from '../utils/validators.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.ADMIN));

router.get('/dashboard', admin.getDashboard);

router.get('/users', validate(userListQuerySchema, 'query'), admin.listUsers);
router.get('/users/:id', admin.getUser);
router.patch('/users/:id', writeLimiter, validate(adminUpdateUserSchema), admin.updateUser);
router.delete('/users/:id', admin.deleteUser);
router.delete('/users/:id/permanent', admin.purgeUser);

router.get('/categories', admin.listCategories);
router.post('/categories', writeLimiter, validate(categorySchema), admin.createCategory);
router.patch('/categories/:id', writeLimiter, validate(updateCategorySchema), admin.updateCategory);
router.delete('/categories/:id', admin.deleteCategory);

router.get('/quizzes', admin.listAllQuizzes);
router.patch('/quizzes/:id/feature', writeLimiter, admin.featureQuiz);
router.delete('/quizzes/:id', quiz.deleteQuiz);

router.get('/system-health', admin.systemHealth);
router.get('/reports', admin.getReports);
router.post('/notifications/broadcast', writeLimiter, admin.broadcast);

export default router;
