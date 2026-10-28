import { Router } from 'express';
import * as student from '../controllers/studentController.js';
import * as subject from '../controllers/subjectController.js';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { ROLES } from '../config/constants.js';
import {
  submitAttemptSchema,
  updateProfileSchema,
  quizListQuerySchema,
  resultListQuerySchema,
  enrollSchema,
} from '../utils/validators.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.STUDENT, ROLES.TEACHER, ROLES.ADMIN));

router.get('/dashboard', student.getDashboard);

/* enrolled subjects & QR enrollment */
router.get('/subjects', subject.listMySubjects);
router.get('/subjects/:id', subject.getMySubject);
router.post('/enroll', writeLimiter, validate(enrollSchema), subject.enroll);
router.post('/enroll/preview', writeLimiter, validate(enrollSchema), subject.previewEnrollmentHandler);
router.get('/quizzes', validate(quizListQuerySchema, 'query'), student.listAvailableQuizzes);
router.post('/quizzes/:id/start', writeLimiter, student.startQuiz);
router.post('/quizzes/:id/submit', writeLimiter, validate(submitAttemptSchema), student.submitQuiz);

router.get('/results', validate(resultListQuerySchema, 'query'), student.listResults);
router.get('/results/:id', student.getResultDetail);
router.get('/in-progress', student.getInProgress);
router.get('/stats', student.getStats);

router.put('/profile', validate(updateProfileSchema), student.updateProfile);
router.post('/avatar', student.uploadUserAvatar);

router.get('/notifications', student.getNotifications);
router.patch('/notifications/read-all', student.readAllNotifications);
router.patch('/notifications/:id/read', student.readNotification);

export default router;
