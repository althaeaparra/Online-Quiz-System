import { Router } from 'express';
import authRoutes from './auth.js';
import studentRoutes from './student.js';
import teacherRoutes from './teacher.js';
import adminRoutes from './admin.js';
import publicRoutes from './api/index.js';
import docsRoutes from './docs.js';

const router = Router();

router.get('/', (_req, res) =>
  res.json({
    success: true,
    data: {
      name: 'CITE BrainCheck API',
      version: '1.0.0',
      docs: '/api/docs',
      openapi: '/api/docs/openapi.json',
      health: '/health',
      endpoints: {
        auth: '/api/auth',
        student: '/api/student',
        teacher: '/api/teacher',
        admin: '/api/admin',
        subjects: '/api/teacher/subjects',
        enrollment: '/api/student/enroll',
        public: '/api',
      },
    },
  }),
);

router.use('/docs', docsRoutes);
router.use('/auth', authRoutes);
router.use('/student', studentRoutes);
router.use('/teacher', teacherRoutes);
router.use('/admin', adminRoutes);
router.use('/', publicRoutes);

export default router;
