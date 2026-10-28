import { Router } from 'express';
import * as teacher from '../controllers/teacherController.js';
import * as quiz from '../controllers/quizController.js';
import * as student from '../controllers/studentController.js';
import * as subject from '../controllers/subjectController.js';
import { authenticate, authorize, ownershipMiddleware } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { writeLimiter } from '../middleware/rateLimit.js';
import { ROLES } from '../config/constants.js';
import { Quiz } from '../models/Quiz.js';
import {
  createQuizSchema,
  updateQuizSchema,
  gradeResultSchema,
  quizListQuerySchema,
  resultListQuerySchema,
  updateProfileSchema,
  createSubjectSchema,
  updateSubjectSchema,
  blockStudentSchema,
  customCategorySchema,
} from '../utils/validators.js';

const router = Router();

router.use(authenticate);
router.use(authorize(ROLES.TEACHER, ROLES.ADMIN));

const ownsQuiz = ownershipMiddleware((req) => Quiz.findById(req.params.id), {
  ownerField: 'teacher',
  resourceName: 'Quiz',
});

router.get('/dashboard', teacher.getDashboard);

/* subjects, QR enrollment and rosters */
router.get('/subjects', subject.listSubjects);
router.post('/subjects', writeLimiter, validate(createSubjectSchema), subject.createSubjectHandler);
router.get('/subjects/:id', subject.getSubject);
router.patch('/subjects/:id', writeLimiter, validate(updateSubjectSchema), subject.updateSubject);
router.post('/subjects/:id/qr', writeLimiter, subject.generateQr);
router.get('/subjects/:id/roster', subject.exportRoster);
router.post('/subjects/:id/students/:studentId/block', writeLimiter, validate(blockStudentSchema), subject.blockSubjectStudent);
router.delete('/subjects/:id/students/:studentId/block', subject.unblockSubjectStudent);
router.delete('/subjects/:id/students/:studentId', subject.removeSubjectStudent);

/* teacher-authored categories */
router.post('/categories', writeLimiter, validate(customCategorySchema), subject.createCategory);

/* quiz authoring */
router.get('/quizzes', validate(quizListQuerySchema, 'query'), quiz.listQuizzes);
router.post('/quizzes', writeLimiter, validate(createQuizSchema), quiz.createQuiz);
router.get('/quizzes/:id', quiz.getQuiz);
router.patch('/quizzes/:id', writeLimiter, ownsQuiz, validate(updateQuizSchema), quiz.updateQuiz);
router.delete('/quizzes/:id', ownsQuiz, quiz.deleteQuiz);
router.post('/quizzes/:id/publish', ownsQuiz, quiz.publishQuiz);
router.post('/quizzes/:id/duplicate', ownsQuiz, quiz.duplicateQuiz);
router.get('/quizzes/:id/analytics', teacher.getQuizAnalytics);
router.post('/quizzes/:id/remind', ownsQuiz, teacher.remindStudents);

/* students & results */
router.get('/students', teacher.listStudents);
router.get('/students/:id', teacher.getStudentProgress);
router.get('/results', validate(resultListQuerySchema, 'query'), teacher.listResults);
router.get('/results/:id', quiz.getResult);
router.post('/results/:id/grade', writeLimiter, validate(gradeResultSchema), quiz.gradeResult);
router.get('/grading', teacher.getGradingQueue);

router.put('/profile', validate(updateProfileSchema), student.updateProfile);

export default router;
