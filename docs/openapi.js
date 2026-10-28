/**
 * OpenAPI 3.1 description of the CITE BrainCheck API.
 * Served at /api/docs/openapi.json and rendered by the built-in docs UI.
 */

const bearer = [{ bearerAuth: [] }, { cookieAuth: [] }];

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});

const envelope = (dataSchema, meta = false) => ({
  type: 'object',
  properties: {
    success: { type: 'boolean', example: true },
    data: dataSchema,
    ...(meta ? { meta: ref('Pagination') } : {}),
  },
});

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'CITE BrainCheck API',
    version: '1.0.0',
    description:
      'Online quiz platform: authentication with rotating refresh tokens, role-scoped dashboards, server-graded attempts, analytics and realtime quiz sessions over Socket.IO.',
    contact: { name: 'CITE BrainCheck', url: 'https://github.com' },
    license: { name: 'MIT' },
  },
  servers: [{ url: '/api', description: 'Current host' }],
  tags: [
    { name: 'Auth', description: 'Registration, sessions, password recovery' },
    { name: 'Public', description: 'Catalogue, categories, leaderboard' },
    { name: 'Student', description: 'Dashboard, attempts, results, profile' },
    { name: 'Teacher', description: 'Quiz authoring, analytics, grading' },
    { name: 'Subjects', description: 'Subject rosters, QR enrollment codes and student blocking' },
    { name: 'Admin', description: 'User, category and system administration' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'qf_access' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { type: 'boolean', example: false },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string', example: 'VALIDATION_ERROR' },
              message: { type: 'string', example: 'Please check the highlighted fields' },
              details: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { field: { type: 'string' }, message: { type: 'string' } },
                },
              },
            },
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          page: { type: 'integer', example: 1 },
          limit: { type: 'integer', example: 12 },
          total: { type: 'integer', example: 42 },
          totalPages: { type: 'integer', example: 4 },
          hasNextPage: { type: 'boolean' },
          hasPrevPage: { type: 'boolean' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string', example: '65f1c2a9e4b0a1b2c3d4e5f6' },
          username: { type: 'string', example: 'ada' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['student', 'teacher', 'admin'] },
          profile: {
            type: 'object',
            properties: {
              firstName: { type: 'string' },
              lastName: { type: 'string' },
              avatar: { type: 'string' },
              bio: { type: 'string' },
              timezone: { type: 'string' },
              language: { type: 'string' },
            },
          },
          academic: {
            type: 'object',
            properties: {
              studentId: { type: 'string' },
              teacherId: { type: 'string' },
              section: { type: 'string', example: 'BSIT-3A' },
              program: { type: 'string', example: 'BSIT' },
              yearLevel: { type: 'string', example: '3rd year' },
              department: { type: 'string', example: 'CITE' },
            },
          },
          stats: {
            type: 'object',
            properties: {
              quizzesTaken: { type: 'integer' },
              averageScore: { type: 'number' },
              totalPoints: { type: 'number' },
              currentStreak: { type: 'integer' },
              longestStreak: { type: 'integer' },
            },
          },
          emailVerified: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      QuestionInput: {
        type: 'object',
        required: ['type', 'question'],
        properties: {
          type: { type: 'string', enum: ['multiple_choice', 'true_false', 'short_answer', 'essay'] },
          question: { type: 'string', example: 'Which planet is known as the Red Planet?' },
          options: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' } } },
            example: [{ text: 'Mars' }, { text: 'Venus' }, { text: 'Jupiter' }],
          },
          correctAnswer: {
            description: 'Option index/array for multiple choice, boolean for true/false, string(s) for short answer',
            oneOf: [{ type: 'number' }, { type: 'boolean' }, { type: 'string' }, { type: 'array', items: { type: 'string' } }],
            example: 0,
          },
          points: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
          timeLimit: { type: 'integer', minimum: 5, maximum: 3600 },
          explanation: { type: 'string' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
        },
      },
      QuizInput: {
        type: 'object',
        required: ['title', 'category', 'questions'],
        properties: {
          title: { type: 'string', example: 'Solar System Basics' },
          description: { type: 'string' },
          category: { type: 'string', example: '65f1c2a9e4b0a1b2c3d4e5f6' },
          subject: { type: 'string', description: 'Optional subject id; gates the quiz to enrolled, unblocked students', nullable: true },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard'] },
          tags: { type: 'array', items: { type: 'string' } },
          questions: { type: 'array', items: ref('QuestionInput') },
          settings: {
            type: 'object',
            properties: {
              timePerQuestion: { type: 'integer', example: 60 },
              randomizeQuestions: { type: 'boolean' },
              showCorrectAnswers: { type: 'boolean' },
              allowRetakes: { type: 'boolean' },
              maxAttempts: { type: 'integer', example: 3 },
              passingScore: { type: 'integer', example: 60 },
            },
          },
          isPublished: { type: 'boolean', default: false },
        },
      },
      Result: {
        type: 'object',
        properties: {
          _id: { type: 'string' },
          quiz: { type: 'object' },
          student: { type: 'string' },
          answers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                studentAnswer: {},
                isCorrect: { type: 'boolean', nullable: true },
                pointsEarned: { type: 'number' },
                maxPoints: { type: 'number' },
                needsManualGrading: { type: 'boolean' },
                feedback: { type: 'string' },
              },
            },
          },
          score: {
            type: 'object',
            properties: {
              totalScore: { type: 'number' },
              maxScore: { type: 'number' },
              percentage: { type: 'number' },
              passed: { type: 'boolean' },
            },
          },
          timeSpent: { type: 'integer', description: 'seconds' },
          attemptNumber: { type: 'integer' },
          status: { type: 'string', enum: ['in_progress', 'submitted', 'graded'] },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
    },
  },
  security: bearer,
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'email', 'password', 'role', 'profile'],
                properties: {
                  username: { type: 'string', minLength: 3, maxLength: 30 },
                  email: { type: 'string', format: 'email' },
                  password: { type: 'string', minLength: 8, description: 'Must contain upper, lower and a number' },
                  role: { type: 'string', enum: ['student', 'teacher'] },
                  profile: { type: 'object', required: ['firstName'], properties: { firstName: { type: 'string' }, lastName: { type: 'string' } } },
                  academic: {
                    type: 'object',
                    description: 'Students need studentId + section; teachers need teacherId + department',
                    properties: {
                      studentId: { type: 'string' },
                      section: { type: 'string', example: 'BSIT-3A' },
                      program: { type: 'string', example: 'BSIT' },
                      yearLevel: { type: 'string' },
                      teacherId: { type: 'string' },
                      department: { type: 'string', example: 'CITE' },
                    },
                  },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Account created', content: { 'application/json': { schema: envelope(ref('User')) } } },
          409: errorResponse('Email or username already in use'),
          422: errorResponse('Validation failed'),
        },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['password'],
                properties: {
                  identifier: { type: 'string', description: 'Email or username' },
                  email: { type: 'string' },
                  username: { type: 'string' },
                  password: { type: 'string' },
                  expectedRole: {
                    type: 'string',
                    enum: ['student', 'teacher', 'admin'],
                    description: 'Portal being used; a mismatched account is refused with 403',
                  },
                },
              },
              example: { identifier: 'student@cite.edu', password: 'Password123', expectedRole: 'student' },
            },
          },
        },
        responses: {
          200: { description: 'Signed in — tokens also set as httpOnly cookies' },
          401: errorResponse('Incorrect credentials'),
          403: errorResponse('Account locked or deactivated'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token and issue a new access token',
        security: [{ cookieAuth: [] }],
        responses: { 200: { description: 'New token pair' }, 401: errorResponse('Invalid or expired session') },
      },
    },
    '/auth/logout': {
      post: { tags: ['Auth'], summary: 'Revoke the current session', responses: { 200: { description: 'Signed out' } } },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Current user',
        responses: { 200: { description: 'Current user', content: { 'application/json': { schema: envelope(ref('User')) } } }, 401: errorResponse('Not signed in') },
      },
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password reset link (always returns 200)',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } } } } },
        responses: { 200: { description: 'Reset email queued if the account exists' } },
      },
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Set a new password with a reset token',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'password'], properties: { token: { type: 'string' }, password: { type: 'string' } } } } } },
        responses: { 200: { description: 'Password updated' }, 422: errorResponse('Invalid or expired token') },
      },
    },
    '/auth/verify-email': {
      post: {
        tags: ['Auth'],
        summary: 'Verify an email address',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } },
        responses: { 200: { description: 'Email verified' } },
      },
    },
    '/quizzes': {
      get: {
        tags: ['Public'],
        summary: 'Browse published quizzes',
        security: [],
        parameters: [
          { name: 'search', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          { name: 'difficulty', in: 'query', schema: { type: 'string', enum: ['easy', 'medium', 'hard'] } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['newest', 'popular', 'rating', 'title'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 12 } },
        ],
        responses: { 200: { description: 'Paginated quiz list', content: { 'application/json': { schema: envelope({ type: 'array', items: { type: 'object' } }, true) } } } },
      },
    },
    '/quizzes/{id}': {
      get: {
        tags: ['Public'],
        summary: 'Quiz detail — answer keys are stripped for students',
        security: [],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Quiz detail' }, 404: errorResponse('Not found') },
      },
    },
    '/categories': {
      get: { tags: ['Public'], summary: 'Active categories with quiz counts', security: [], responses: { 200: { description: 'Category list' } } },
    },
    '/leaderboard': {
      get: {
        tags: ['Public'],
        summary: 'All-time points leaderboard',
        security: [],
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 10 } }],
        responses: { 200: { description: 'Ranked students' } },
      },
    },
    '/stats': {
      get: { tags: ['Public'], summary: 'Platform counters for the landing page', security: [], responses: { 200: { description: 'Counters' } } },
    },
    '/config': {
      get: {
        tags: ['Public'],
        summary: 'Public client flags — currently whether the admin portal button is shown',
        description: '`showAdminPortal` is true only when SHOW_ADMIN_LINK=true. No secrets are returned.',
        security: [],
        responses: { 200: { description: 'Client configuration' } },
      },
    },
    '/student/dashboard': {
      get: { tags: ['Student'], summary: 'Dashboard: stats, recommendations and streak', responses: { 200: { description: 'Dashboard payload' }, 401: errorResponse('Not signed in') } },
    },
    '/student/quizzes': {
      get: {
        tags: ['Student'],
        summary: 'Quizzes available to the signed-in student',
        parameters: [{ name: 'search', in: 'query', schema: { type: 'string' } }, { name: 'page', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: { description: 'Quiz list with attempt info' } },
      },
    },
    '/student/quizzes/{id}/start': {
      post: {
        tags: ['Student'],
        summary: 'Start or resume an attempt',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Attempt with shuffled questions and a server deadline' },
          403: errorResponse('Not published, retakes disabled or attempts exhausted'),
        },
      },
    },
    '/student/quizzes/{id}/submit': {
      post: {
        tags: ['Student'],
        summary: 'Submit answers for server-side grading',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  attemptId: { type: 'string' },
                  answers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: { questionId: { type: 'string' }, answer: {} },
                    },
                  },
                  timeSpent: { type: 'integer', description: 'seconds' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Graded result + summary', content: { 'application/json': { schema: envelope(ref('Result')) } } },
          404: errorResponse('No active attempt'),
          409: errorResponse('Attempt already submitted'),
        },
      },
    },
    '/student/results': {
      get: { tags: ['Student'], summary: 'Result history', parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }], responses: { 200: { description: 'Paginated results' } } },
    },
    '/student/results/{id}': {
      get: {
        tags: ['Student'],
        summary: 'Detailed result review',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Result with per-question feedback' }, 403: errorResponse('Not your result') },
      },
    },
    '/student/stats': {
      get: { tags: ['Student'], summary: 'Performance analytics', parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 90 } }], responses: { 200: { description: 'Trends, strengths and weak areas' } } },
    },
    '/student/profile': {
      put: { tags: ['Student'], summary: 'Update profile and preferences', responses: { 200: { description: 'Updated user' } } },
    },
    '/teacher/dashboard': {
      get: { tags: ['Teacher'], summary: 'Teaching overview: subjects, enrollment and grading queue', responses: { 200: { description: 'Dashboard payload' } } },
    },
    '/teacher/subjects': {
      get: { tags: ['Subjects'], summary: "List the teacher's subjects with quiz counts and QR state", responses: { 200: { description: 'Subject list' } } },
      post: {
        tags: ['Subjects'],
        summary: 'Create a subject for a section',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['subjectCode', 'subjectName', 'section'],
                properties: {
                  subjectCode: { type: 'string', example: 'CS101' },
                  subjectName: { type: 'string', example: 'Programming 1' },
                  description: { type: 'string' },
                  section: { type: 'string', example: 'BSIT-3A' },
                  program: { type: 'string', example: 'BSIT' },
                  category: { type: 'string' },
                  color: { type: 'string', example: '#f97316' },
                  enrollment: {
                    type: 'object',
                    properties: {
                      allowQr: { type: 'boolean', default: true },
                      isOpen: { type: 'boolean', default: true },
                      maxStudents: { type: 'integer', default: 50 },
                      requireApproval: { type: 'boolean', default: false },
                      qrExpiresInHours: { type: 'integer', default: 168 },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Subject created' }, 409: errorResponse('Duplicate code for the section') },
      },
    },
    '/teacher/subjects/{id}': {
      get: { tags: ['Subjects'], summary: 'Subject detail with the section roster and standings', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Subject + roster' }, 403: errorResponse('Not the owner') } },
      patch: { tags: ['Subjects'], summary: 'Update subject settings', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Updated subject' } } },
    },
    '/teacher/subjects/{id}/roster': {
      get: {
        tags: ['Subjects'],
        summary: 'Download the section roster as a CSV (name, student ID, section, status, block reason, enrolled date)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'CSV attachment of the roster, blocked students included' },
          403: errorResponse('Not the subject owner'),
        },
      },
    },
    '/teacher/subjects/{id}/qr': {
      post: {
        tags: ['Subjects'],
        summary: 'Issue or rotate the enrollment code and QR image',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { expiresInHours: { type: 'integer', default: 168 } } } } } },
        responses: { 200: { description: 'Enrollment code, join URL and PNG data URL' } },
      },
    },
    '/teacher/subjects/{id}/students/{studentId}/block': {
      post: {
        tags: ['Subjects'],
        summary: 'Block a student from the subject',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'studentId', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string', maxLength: 200 } } } } } },
        responses: { 200: { description: 'Roster with the blocked student' } },
      },
      delete: { tags: ['Subjects'], summary: 'Unblock a student', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'studentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Roster' } } },
    },
    '/teacher/subjects/{id}/students/{studentId}': {
      delete: { tags: ['Subjects'], summary: 'Remove a student from the subject', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'studentId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Roster' } } },
    },
    '/teacher/categories': {
      post: {
        tags: ['Subjects'],
        summary: 'Create a custom category (returns the existing one if the name is taken)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string' }, description: { type: 'string' } } } } } },
        responses: { 201: { description: 'Category created' }, 200: { description: 'Existing category reused' } },
      },
    },
    '/student/subjects': {
      get: { tags: ['Subjects'], summary: 'Subjects the student joined, with standing', responses: { 200: { description: 'Enrolled subjects' } } },
    },
    '/student/subjects/{id}': {
      get: { tags: ['Subjects'], summary: 'Subject page with its published quizzes (members only)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Subject and quizzes' }, 403: errorResponse('Not enrolled') } },
    },
    '/student/enroll/preview': {
      post: {
        tags: ['Subjects'],
        summary: 'Preview a subject from an enrollment code',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', example: 'K7F2-QX9M' } } } } } },
        responses: { 200: { description: 'Subject preview with section mismatch / already enrolled flags' }, 404: errorResponse('Unknown code') },
      },
    },
    '/student/enroll': {
      post: {
        tags: ['Subjects'],
        summary: 'Join a subject with an enrollment code',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } },
        responses: { 201: { description: 'Enrolled (or pending approval)' }, 403: errorResponse('Blocked, expired, full or wrong section'), 404: errorResponse('Unknown code') },
      },
    },
    '/teacher/quizzes': {
      get: { tags: ['Teacher'], summary: "List the teacher's quizzes (drafts included)", responses: { 200: { description: 'Paginated quizzes' } } },
      post: {
        tags: ['Teacher'],
        summary: 'Create a quiz',
        requestBody: { required: true, content: { 'application/json': { schema: ref('QuizInput') } } },
        responses: { 201: { description: 'Quiz created' }, 422: errorResponse('Validation failed') },
      },
    },
    '/teacher/quizzes/{id}': {
      patch: { tags: ['Teacher'], summary: 'Update a quiz', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Updated quiz' }, 403: errorResponse('Not the owner') } },
      delete: { tags: ['Teacher'], summary: 'Delete or archive a quiz', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' }, 200: { description: 'Archived because attempts exist' } } },
    },
    '/teacher/quizzes/{id}/publish': {
      post: {
        tags: ['Teacher'],
        summary: 'Publish or unpublish a quiz',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { isPublished: { type: 'boolean', default: true } } } } } },
        responses: { 200: { description: 'Updated quiz' } },
      },
    },
    '/teacher/quizzes/{id}/analytics': {
      get: { tags: ['Teacher'], summary: 'Score distribution, question difficulty and timeline', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Quiz analytics' } } },
    },
    '/teacher/students': {
      get: { tags: ['Teacher'], summary: 'Students who attempted your quizzes', responses: { 200: { description: 'Paginated student list' } } },
    },
    '/teacher/grading': {
      get: { tags: ['Teacher'], summary: 'Submitted attempts with essay answers awaiting a grade', responses: { 200: { description: 'Grading queue' } } },
    },
    '/teacher/results/{id}/grade': {
      post: {
        tags: ['Teacher'],
        summary: 'Grade essay answers',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  grades: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        questionId: { type: 'string' },
                        pointsEarned: { type: 'number' },
                        feedback: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: 'Graded result' } },
      },
    },
    '/admin/dashboard': {
      get: { tags: ['Admin'], summary: 'System analytics and health snapshot, including subject/enrollment/QR totals', responses: { 200: { description: 'Admin dashboard' }, 403: errorResponse('Admin only') } },
    },
    '/admin/users': {
      get: { tags: ['Admin'], summary: 'List users', parameters: [{ name: 'role', in: 'query', schema: { type: 'string' } }, { name: 'search', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Paginated users' } } },
    },
    '/admin/users/{id}': {
      patch: { tags: ['Admin'], summary: 'Update role, status or profile', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Updated user' } } },
      delete: { tags: ['Admin'], summary: 'Deactivate a user (history preserved)', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Deactivated' } } },
    },
    '/admin/categories': {
      get: { tags: ['Admin'], summary: 'All categories including inactive', responses: { 200: { description: 'Categories' } } },
      post: { tags: ['Admin'], summary: 'Create a category', responses: { 201: { description: 'Created' } } },
    },
    '/admin/categories/{id}': {
      patch: { tags: ['Admin'], summary: 'Update a category', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Updated' } } },
      delete: { tags: ['Admin'], summary: 'Delete an unused category', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Deleted' }, 409: errorResponse('Category in use') } },
    },
    '/admin/system-health': {
      get: { tags: ['Admin'], summary: 'Uptime, memory, database and cache status', responses: { 200: { description: 'Healthy' }, 503: { description: 'Degraded' } } },
    },
    '/admin/reports': {
      get: {
        tags: ['Admin'],
        summary: 'Generate a report (overview, users, quizzes, results, subjects; CSV for subjects)',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['overview', 'users', 'quizzes', 'results', 'subjects'] } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } },
          { name: 'days', in: 'query', description: 'Window for the subjects report', schema: { type: 'integer', default: 30, maximum: 365 } },
          { name: 'format', in: 'query', description: 'csv is supported for type=subjects', schema: { type: 'string', enum: ['json', 'csv'] } },
          { name: 'download', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          200: { description: 'Report payload, JSON download, or a CSV attachment (department totals plus one row per subject)' },
          422: errorResponse('CSV requested for a report type that has no CSV shape'),
        },
      },
    },
  },
};

export default openApiSpec;
