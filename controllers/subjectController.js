import { Subject } from '../models/Subject.js';
import { Quiz } from '../models/Quiz.js';
import { Result } from '../models/Result.js';
import { ROLES, RESULT_STATUS } from '../config/constants.js';
import { asyncHandler, ForbiddenError, NotFoundError } from '../utils/errors.js';
import { ok, created } from '../utils/response.js';
import { round, toCsv } from '../utils/helpers.js';
import { summariseQuiz } from '../services/quizService.js';
import {
  blockStudent,
  createCustomCategory,
  createSubject,
  enrollStudent,
  getOwnedSubject,
  issueEnrollmentCode,
  listStudentSubjects,
  listTeacherSubjects,
  previewEnrollment,
  removeStudent,
  serialiseSubject,
  unblockStudent,
} from '../services/subjectService.js';

const requestOrigin = (req) => process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

/** Subject detail plus the roster, each student's standing in this subject's quizzes. */
async function subjectDetail(subject) {
  await subject.populate('students.student', 'username email profile academic stats lastLogin');
  const quizzes = await Quiz.find({ subject: subject._id })
    .select('title isPublished analytics difficulty')
    .lean({ virtuals: true });

  const quizIds = quizzes.map((q) => q._id);
  const aggregates = quizIds.length
    ? await Result.aggregate([
        { $match: { quiz: { $in: quizIds }, status: { $ne: RESULT_STATUS.IN_PROGRESS } } },
        {
          $group: {
            _id: '$student',
            attempts: { $sum: 1 },
            averageScore: { $avg: '$score.percentage' },
            bestScore: { $max: '$score.percentage' },
            lastAttemptAt: { $max: '$completedAt' },
          },
        },
      ])
    : [];
  const byStudent = new Map(aggregates.map((a) => [a._id.toString(), a]));

  const roster = subject.students.map((row) => {
    const student = row.student && typeof row.student === 'object' ? row.student : null;
    const stats = student ? byStudent.get(student._id.toString()) : null;
    return {
      student: student
        ? {
            id: student._id,
            username: student.username,
            email: student.email,
            name: [student.profile?.firstName, student.profile?.lastName].filter(Boolean).join(' ') || student.username,
            avatar: student.profile?.avatar || '',
            studentId: student.academic?.studentId || '',
            section: student.academic?.section || '',
            program: student.academic?.program || '',
            yearLevel: student.academic?.yearLevel || '',
          }
        : { id: row.student },
      enrolledAt: row.enrolledAt,
      method: row.method,
      status: row.status,
      blocked: row.blocked,
      blockedAt: row.blockedAt,
      blockReason: row.blockReason,
      attempts: stats?.attempts || 0,
      averageScore: round(stats?.averageScore || 0),
      bestScore: round(stats?.bestScore || 0),
      lastAttemptAt: stats?.lastAttemptAt || null,
    };
  });

  roster.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    return (b.averageScore || 0) - (a.averageScore || 0);
  });

  return {
    ...serialiseSubject(subject),
    students: roster,
    quizzes,
  };
}

/* ── teacher: subjects ──────────────────────────────────────────────────── */

/** GET /api/teacher/subjects */
export const listSubjects = asyncHandler(async (req, res) => ok(res, await listTeacherSubjects(req.user._id)));

/** POST /api/teacher/subjects */
export const createSubjectHandler = asyncHandler(async (req, res) => {
  const subject = await createSubject({ teacherId: req.user._id, input: req.body });
  return created(res, serialiseSubject(subject), { message: `${subject.subjectCode} created` });
});

/** GET /api/teacher/subjects/:id */
export const getSubject = asyncHandler(async (req, res) => {
  const subject = await getOwnedSubject(req.user._id, req.params.id, { role: req.user.role });
  return ok(res, await subjectDetail(subject));
});

/** PATCH /api/teacher/subjects/:id */
export const updateSubject = asyncHandler(async (req, res) => {
  const subject = await getOwnedSubject(req.user._id, req.params.id, { role: req.user.role });
  const { subjectCode, subjectName, description, section, program, category, color, enrollment, isArchived } = req.body;

  if (subjectCode !== undefined) subject.subjectCode = subjectCode;
  if (subjectName !== undefined) subject.subjectName = subjectName;
  if (description !== undefined) subject.description = description;
  if (section !== undefined) subject.section = section;
  if (program !== undefined) subject.program = program;
  if (category !== undefined) subject.category = category || null;
  if (color !== undefined) subject.color = color;
  if (isArchived !== undefined) subject.isArchived = isArchived;
  if (enrollment) subject.enrollment = { ...subject.enrollment.toObject(), ...enrollment };

  await subject.save();
  return ok(res, await subjectDetail(subject), { message: 'Subject updated' });
});

/** POST /api/teacher/subjects/:id/qr — issue/rotate the enrollment code + QR image. */
export const generateQr = asyncHandler(async (req, res) => {
  const subject = await getOwnedSubject(req.user._id, req.params.id, { role: req.user.role });
  const issued = await issueEnrollmentCode(subject, requestOrigin(req), {
    expiresInHours: req.body?.expiresInHours,
  });

  return ok(res, {
    ...issued,
    subject: serialiseSubject(subject),
  }, { message: 'Enrollment QR code ready' });
});

/**
 * GET /api/teacher/subjects/:id/roster — the section roster as a CSV download.
 * Includes blocked students, so the file always matches the on-screen roster.
 */
export const exportRoster = asyncHandler(async (req, res) => {
  const subject = await getOwnedSubject(req.user._id, req.params.id, { role: req.user.role });
  await subject.populate('students.student', 'username email profile academic');

  const rows = subject.students
    .map((row) => {
      const student = row.student && typeof row.student === 'object' ? row.student : null;
      const name = student
        ? [student.profile?.firstName, student.profile?.lastName].filter(Boolean).join(' ') || student.username
        : 'Student';

      return [
        name,
        student?.academic?.studentId || '',
        student?.academic?.section || subject.section,
        row.blocked ? 'blocked' : row.status,
        row.blocked ? row.blockReason || '' : '',
        row.enrolledAt ? new Date(row.enrolledAt).toISOString() : '',
      ];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${subject.subjectCode}-${subject.section}-roster-${Date.now()}.csv"`,
  );
  // BOM keeps Excel on UTF-8 for accented names.
  return res.status(200).send(`\uFEFF${toCsv([['name', 'student_id', 'section', 'status', 'blocked_reason', 'enrolled_at'], ...rows])}`);
});

/** POST /api/teacher/subjects/:id/students/:studentId/block */
export const blockSubjectStudent = asyncHandler(async (req, res) => {
  const subject = await blockStudent({
    teacherId: req.user._id,
    subjectId: req.params.id,
    studentId: req.params.studentId,
    reason: req.body?.reason || '',
    role: req.user.role,
  });
  return ok(res, await subjectDetail(subject), { message: 'Student blocked from this subject' });
});

/** DELETE /api/teacher/subjects/:id/students/:studentId/block */
export const unblockSubjectStudent = asyncHandler(async (req, res) => {
  const subject = await unblockStudent({
    teacherId: req.user._id,
    subjectId: req.params.id,
    studentId: req.params.studentId,
    role: req.user.role,
  });
  return ok(res, await subjectDetail(subject), { message: 'Student unblocked' });
});

/** DELETE /api/teacher/subjects/:id/students/:studentId */
export const removeSubjectStudent = asyncHandler(async (req, res) => {
  const subject = await removeStudent({
    teacherId: req.user._id,
    subjectId: req.params.id,
    studentId: req.params.studentId,
    role: req.user.role,
  });
  return ok(res, await subjectDetail(subject), { message: 'Student removed from this subject' });
});

/* ── teacher: custom categories ─────────────────────────────────────────── */

/** POST /api/teacher/categories */
export const createCategory = asyncHandler(async (req, res) => {
  const { category, reused } = await createCustomCategory({ teacherId: req.user._id, input: req.body });
  const payload = {
    id: category._id,
    _id: category._id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    color: category.color,
    icon: category.icon,
  };
  return (reused ? ok : created)(res, payload, {
    message: reused ? 'That category already exists — selected it for you' : 'Category added',
  });
});

/* ── student ────────────────────────────────────────────────────────────── */

/** GET /api/student/subjects */
export const listMySubjects = asyncHandler(async (req, res) => ok(res, await listStudentSubjects(req.user._id)));

/** POST /api/student/enroll/preview */
export const previewEnrollmentHandler = asyncHandler(async (req, res) => {
  const preview = await previewEnrollment(req.body.code, req.user);
  return ok(res, preview);
});

/** POST /api/student/enroll */
export const enroll = asyncHandler(async (req, res) => {
  const result = await enrollStudent({ code: req.body.code, student: req.user });

  if (result.alreadyEnrolled) {
    return ok(res, result, { message: `You are already enrolled in ${result.subject.subjectCode}` });
  }

  return created(res, result, {
    message: result.pendingApproval
      ? `Request sent — waiting for your teacher to approve ${result.subject.subjectCode}`
      : `Enrolled in ${result.subject.subjectCode} · ${result.subject.subjectName}`,
  });
});

/** GET /api/student/subjects/:id — subject page with its quizzes for a member. */
export const getMySubject = asyncHandler(async (req, res) => {
  const subject = await Subject.findById(req.params.id).populate('teacher', 'username profile academic');
  if (!subject || subject.isArchived) throw new NotFoundError('Subject');

  const row = subject.enrollmentFor(req.user._id);
  if (!row) throw new ForbiddenError('You are not enrolled in this subject');

  const quizzes = await Quiz.find({ subject: subject._id, isPublished: true })
    .populate('category', 'name color')
    .select('title description difficulty analytics settings category createdAt questions._id questions.points questions.timeLimit')
    .lean({ virtuals: true });

  return ok(res, {
    ...serialiseSubject(subject),
    teacherName: [subject.teacher?.profile?.firstName, subject.teacher?.profile?.lastName]
      .filter(Boolean)
      .join(' ') || subject.teacher?.username,
    myEnrollment: {
      enrolledAt: row.enrolledAt,
      method: row.method,
      status: row.status,
      blocked: row.blocked,
      blockReason: row.blockReason,
    },
    quizzes: quizzes.map(summariseQuiz),
  });
});

export default {
  listSubjects,
  createSubjectHandler,
  getSubject,
  updateSubject,
  generateQr,
  exportRoster,
  blockSubjectStudent,
  unblockSubjectStudent,
  removeSubjectStudent,
  createCategory,
  listMySubjects,
  previewEnrollmentHandler,
  enroll,
  getMySubject,
};
