import { Router } from 'express';
import * as publicApi from '../../controllers/publicController.js';
import * as quiz from '../../controllers/quizController.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validation.js';
import { quizListQuerySchema } from '../../utils/validators.js';

/**
 * Public catalogue API — everything here is readable without an account except
 * result review, which requires the owning student/teacher/admin.
 */
const router = Router();

router.get('/quizzes', optionalAuth, validate(quizListQuerySchema, 'query'), quiz.listQuizzes);
router.get('/quizzes/:id', optionalAuth, quiz.getQuiz);
router.get('/quizzes/:id/questions', optionalAuth, quiz.getQuizQuestions);

router.get('/config', publicApi.getClientConfig);
router.get('/categories', publicApi.getCategories);
router.get('/leaderboard', publicApi.getLeaderboard);
router.get('/stats', publicApi.getPlatformStats);

router.get('/results/:id', authenticate, quiz.getResult);

export default router;
