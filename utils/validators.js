import { z } from 'zod';
import { QUESTION_TYPE_VALUES, ROLE_VALUES, ROLES } from '../config/constants.js';

/* ── primitives ─────────────────────────────────────────────────────────── */

export const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, 'Invalid identifier');

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a number');

const username = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(30, 'Username must be at most 30 characters')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Username may only contain letters, numbers, dot, dash or underscore');

const email = z.string().trim().toLowerCase().email('Enter a valid email address');

const pagination = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};

/* ── auth ───────────────────────────────────────────────────────────────── */

const academic = z
  .object({
    studentId: z.string().trim().max(30).optional(),
    yearLevel: z.string().trim().max(20).optional(),
    section: z.string().trim().max(40).optional(),
    program: z.string().trim().max(80).optional(),
    teacherId: z.string().trim().max(30).optional(),
    department: z.string().trim().max(80).optional(),
  })
  .optional();

export const registerSchema = z
  .object({
    username,
    email,
    password,
    role: z.enum([ROLES.STUDENT, ROLES.TEACHER]),
    academic,
    profile: z
      .object({
        firstName: z.string().trim().max(50).optional(),
        lastName: z.string().trim().max(50).optional(),
        timezone: z.string().trim().max(60).optional(),
        language: z.string().trim().max(10).optional(),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.profile?.firstName) {
      ctx.addIssue({ code: 'custom', path: ['profile', 'firstName'], message: 'First name is required' });
    }
    if (data.role === ROLES.STUDENT) {
      if (!data.academic?.studentId) {
        ctx.addIssue({ code: 'custom', path: ['academic', 'studentId'], message: 'Student ID is required' });
      }
      if (!data.academic?.section) {
        ctx.addIssue({ code: 'custom', path: ['academic', 'section'], message: 'Section is required' });
      }
    }
    if (data.role === ROLES.TEACHER) {
      if (!data.academic?.teacherId) {
        ctx.addIssue({ code: 'custom', path: ['academic', 'teacherId'], message: 'Teacher ID is required' });
      }
      if (!data.academic?.department) {
        ctx.addIssue({ code: 'custom', path: ['academic', 'department'], message: 'Department is required' });
      }
    }
  });

export const loginSchema = z
  .object({
    identifier: z.string().trim().min(1, 'Email or username is required').optional(),
    email: z.string().trim().optional(),
    username: z.string().trim().optional(),
    password: z.string().min(1, 'Password is required'),
    // A role-scoped sign-in page passes the role it expects; the API refuses
    // accounts from the other portal so students and teachers never mix.
    expectedRole: z.enum(ROLE_VALUES).optional(),
  })
  .refine((data) => data.identifier || data.email || data.username, {
    message: 'Email or username is required',
    path: ['identifier'],
  });

export const refreshSchema = z.object({ refreshToken: z.string().optional() }).optional();

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(20, 'Invalid reset token'),
  password,
});

export const verifyEmailSchema = z.object({ token: z.string().min(20, 'Invalid verification token') });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: password,
});

/* ── profile ────────────────────────────────────────────────────────────── */

export const updateProfileSchema = z.object({
  academic: z
    .object({
      yearLevel: z.string().trim().max(20).optional(),
      section: z.string().trim().max(40).optional(),
      program: z.string().trim().max(80).optional(),
      department: z.string().trim().max(80).optional(),
    })
    .optional(),
  profile: z
    .object({
      firstName: z.string().trim().max(50).optional(),
      lastName: z.string().trim().max(50).optional(),
      bio: z.string().trim().max(500).optional(),
      avatar: z.string().trim().url().max(500).optional().or(z.literal('')),
      timezone: z.string().trim().max(60).optional(),
      language: z.string().trim().max(10).optional(),
    })
    .optional(),
  preferences: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).optional(),
      emailNotifications: z.boolean().optional(),
      pushNotifications: z.boolean().optional(),
      privacy: z
        .object({
          showOnLeaderboard: z.boolean().optional(),
          shareStats: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

/* ── questions & quizzes ────────────────────────────────────────────────── */

const optionSchema = z.object({
  text: z.string().trim().min(1, 'Option text is required').max(500),
});

export const questionInputSchema = z
  .object({
    type: z.enum(QUESTION_TYPE_VALUES),
    question: z.string().trim().min(3, 'Question text is required').max(2000),
    options: z.array(optionSchema).max(8).optional().default([]),
    correctAnswer: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
    points: z.coerce.number().int().min(1).max(100).default(1),
    timeLimit: z.coerce.number().int().min(5).max(3600).optional(),
    explanation: z.string().trim().max(1000).optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    imageUrl: z.string().trim().url().optional().or(z.literal('')),
    order: z.coerce.number().int().min(0).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type === 'multiple_choice') {
      if (!q.options || q.options.length < 2) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Multiple choice needs at least 2 options' });
      }
      const answer = q.correctAnswer;
      const validIndexes =
        typeof answer === 'number'
          ? answer >= 0 && answer < q.options.length
          : Array.isArray(answer) && answer.every((a) => Number.isInteger(Number(a)) && Number(a) < q.options.length);
      if (!validIndexes) {
        ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'correctAnswer must be a valid option index' });
      }
    }
    if (q.type === 'true_false' && typeof q.correctAnswer !== 'boolean' && !['true', 'false'].includes(String(q.correctAnswer))) {
      ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'correctAnswer must be true or false' });
    }
    if (['short_answer', 'essay'].includes(q.type) && !q.correctAnswer) {
      if (q.type === 'short_answer') {
        ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'Short answer questions need an answer key' });
      }
    }
  });

export const quizSettingsSchema = z
  .object({
    timePerQuestion: z.coerce.number().int().min(10).max(3600).optional(),
    totalTimeLimit: z.coerce.number().int().min(60).max(43200).optional(),
    randomizeQuestions: z.boolean().optional(),
    randomizeOptions: z.boolean().optional(),
    showCorrectAnswers: z.boolean().optional(),
    allowRetakes: z.boolean().optional(),
    maxAttempts: z.coerce.number().int().min(1).max(20).optional(),
    passingScore: z.coerce.number().int().min(0).max(100).optional(),
    showResultsImmediately: z.boolean().optional(),
  })
  .optional();

export const createQuizSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(2000).optional(),
  category: objectId,
  subject: objectId.nullish(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
  questions: z.array(questionInputSchema).min(1, 'A quiz needs at least one question').max(100),
  settings: quizSettingsSchema,
  isPublished: z.boolean().optional(),
});

export const updateQuizSchema = createQuizSchema.partial().extend({
  questions: z.array(questionInputSchema).min(1).max(100).optional(),
});

export const quizListQuerySchema = z.object({
  ...pagination,
  search: z.string().trim().max(120).optional(),
  category: objectId.optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  featured: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'popular', 'rating', 'title']).optional(),
});

/* ── attempts & grading ─────────────────────────────────────────────────── */

export const startAttemptSchema = z.object({}).optional();

export const submitAttemptSchema = z.object({
  attemptId: z.string().min(4).optional(),
  answers: z
    .array(
      z.object({
        questionId: objectId,
        answer: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
      }),
    )
    .max(200)
    .default([]),
  timeSpent: z.coerce.number().int().min(0).max(86400).optional(),
});

export const gradeResultSchema = z.object({
  grades: z
    .array(
      z.object({
        questionId: objectId,
        pointsEarned: z.coerce.number().min(0).max(100),
        feedback: z.string().trim().max(1000).optional(),
      }),
    )
    .min(1, 'Provide at least one grade'),
});

/* ── categories ─────────────────────────────────────────────────────────── */

export const categorySchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).optional(),
  icon: z.string().trim().max(40).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex value')
    .optional(),
  parentCategory: objectId.nullish(),
  isActive: z.boolean().optional(),
  order: z.coerce.number().int().min(0).optional(),
});

export const updateCategorySchema = categorySchema.partial();

/* ── subjects & enrollment ─────────────────────────────────────────────── */

const subjectCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Subject code is required')
  .max(20)
  .regex(/^[A-Z0-9-]+$/, 'Use letters, numbers and dashes only');

const section = z.string().trim().toUpperCase().min(1, 'Section is required').max(40);

export const createSubjectSchema = z.object({
  subjectCode,
  subjectName: z.string().trim().min(2, 'Subject name is required').max(120),
  description: z.string().trim().max(500).optional(),
  section,
  program: z.string().trim().max(80).optional(),
  category: objectId.nullish(),
  color: z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex value')
    .optional(),
  enrollment: z
    .object({
      allowQr: z.boolean().optional(),
      isOpen: z.boolean().optional(),
      maxStudents: z.coerce.number().int().min(1).max(500).optional(),
      requireApproval: z.boolean().optional(),
      qrExpiresInHours: z.coerce.number().int().min(1).max(8760).optional(),
    })
    .optional(),
});

export const updateSubjectSchema = createSubjectSchema.partial().extend({
  isArchived: z.boolean().optional(),
});

export const enrollSchema = z.object({
  code: z.string().trim().min(6, 'Enter the enrollment code').max(80),
});

/** Enroll-link payload: either a raw token or the parsed enrollment code. */
export const enrollmentLookupSchema = z.object({
  code: z.string().trim().min(6).max(80),
});

export const blockStudentSchema = z.object({
  reason: z.string().trim().max(200).optional(),
});

export const customCategorySchema = z.object({
  name: z.string().trim().min(2, 'Category name is required').max(60),
  description: z.string().trim().max(300).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex value')
    .optional(),
  icon: z.string().trim().max(40).optional(),
});

/* ── admin ──────────────────────────────────────────────────────────────── */

export const adminUpdateUserSchema = z.object({
  role: z.enum(ROLE_VALUES).optional(),
  isActive: z.boolean().optional(),
  emailVerified: z.boolean().optional(),
  profile: updateProfileSchema.shape.profile,
});

export const userListQuerySchema = z.object({
  ...pagination,
  role: z.enum(ROLE_VALUES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(120).optional(),
});

export const resultListQuerySchema = z.object({
  ...pagination,
  quiz: objectId.optional(),
  student: objectId.optional(),
  status: z.enum(['in_progress', 'submitted', 'graded']).optional(),
});

export default {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  changePasswordSchema,
  updateProfileSchema,
  questionInputSchema,
  createQuizSchema,
  updateQuizSchema,
  quizListQuerySchema,
  submitAttemptSchema,
  gradeResultSchema,
  categorySchema,
  updateCategorySchema,
  createSubjectSchema,
  updateSubjectSchema,
  enrollSchema,
  enrollmentLookupSchema,
  blockStudentSchema,
  customCategorySchema,
  adminUpdateUserSchema,
  userListQuerySchema,
  resultListQuerySchema,
};
