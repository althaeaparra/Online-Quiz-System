/**
 * Application-wide constants. Keeping these in one place avoids magic strings
 * leaking into models, controllers and services.
 */

export const ROLES = Object.freeze({
  STUDENT: 'student',
  TEACHER: 'teacher',
  ADMIN: 'admin',
});

export const ROLE_VALUES = Object.values(ROLES);

export const QUESTION_TYPES = Object.freeze({
  MULTIPLE_CHOICE: 'multiple_choice',
  TRUE_FALSE: 'true_false',
  SHORT_ANSWER: 'short_answer',
  ESSAY: 'essay',
});

export const QUESTION_TYPE_VALUES = Object.values(QUESTION_TYPES);

export const QUESTION_TYPE_LABELS = Object.freeze({
  multiple_choice: 'Multiple choice',
  true_false: 'True / false',
  short_answer: 'Short answer',
  essay: 'Essay',
});

export const NOTIFICATION_TYPES = Object.freeze({
  QUIZ_AVAILABLE: 'quiz_available',
  QUIZ_REMINDER: 'quiz_reminder',
  RESULT_PUBLISHED: 'result_published',
  ACHIEVEMENT: 'achievement',
  SYSTEM: 'system',
});

export const NOTIFICATION_TYPE_VALUES = Object.values(NOTIFICATION_TYPES);

export const RESULT_STATUS = Object.freeze({
  IN_PROGRESS: 'in_progress',
  SUBMITTED: 'submitted',
  GRADED: 'graded',
});

export const QUIZ_DEFAULTS = Object.freeze({
  timePerQuestion: 60,
  randomizeQuestions: false,
  randomizeOptions: false,
  showCorrectAnswers: true,
  allowRetakes: true,
  maxAttempts: 3,
  passingScore: 60,
  showResultsImmediately: true,
});

export const QUIZ_LIMITS = Object.freeze({
  maxQuestions: 100,
  maxOptions: 8,
  maxTitleLength: 140,
  maxAttemptWindowMinutes: 24 * 60,
});

export const TOKEN_TYPES = Object.freeze({
  ACCESS: 'access',
  REFRESH: 'refresh',
  EMAIL_VERIFICATION: 'email_verification',
  PASSWORD_RESET: 'password_reset',
});

export const COOKIE_NAMES = Object.freeze({
  ACCESS: 'qf_access',
  REFRESH: 'qf_refresh',
});

export const ATTEMPT_KEY_PREFIX = 'attempt:';
export const QUIZ_SESSION_PREFIX = 'quiz-session:';
export const LEADERBOARD_KEY = 'leaderboard:global';
export const CACHE_PREFIX = 'cache:';
