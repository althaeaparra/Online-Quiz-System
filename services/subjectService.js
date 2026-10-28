import crypto from 'node:crypto';
import QRCode from 'qrcode';

import { Subject } from '../models/Subject.js';
import { Quiz } from '../models/Quiz.js';
import { Category } from '../models/Category.js';
import { ROLES } from '../config/constants.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/errors.js';
import { round } from '../utils/helpers.js';

/**
 * Short, human-typable enrollment codes. Ambiguous characters (O/0, I/1, L)
 * are excluded so a code read aloud or copied from a whiteboard still works.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateEnrollmentCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  // K7F2-QX9M reads better than K7F2QX9M.
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const normalizeEnrollmentCode = (input = '') => {
  const raw = String(input).trim();
  // Accept a full join link as well as the bare code.
  const fromUrl = raw.match(/\/enroll\/([A-Za-z0-9-]+)/)?.[1] || raw;
  return fromUrl.replace(/\s+/g, '').toUpperCase();
};

export const enrollmentUrl = (origin, code) => `${origin.replace(/\/$/, '')}/#/enroll/${code}`;

/* ── serialisation ──────────────────────────────────────────────────────── */

export function serialiseSubject(subject, { includeStudents = false } = {}) {
  const doc = subject?.toObject ? subject.toObject({ virtuals: true }) : subject;
  if (!doc) return null;

  const students = doc.students || [];
  const state = subject?.enrollmentState ? subject.enrollmentState() : {
    active: Boolean(doc.enrollmentCode?.expiresAt && new Date(doc.enrollmentCode.expiresAt) > new Date()),
    expiresAt: doc.enrollmentCode?.expiresAt || null,
    createdAt: doc.enrollmentCode?.createdAt || null,
  };

  const payload = {
    id: doc._id?.toString?.() || doc.id,
    _id: doc._id,
    subjectCode: doc.subjectCode,
    subjectName: doc.subjectName,
    description: doc.description,
    section: doc.section,
    program: doc.program,
    category: doc.category,
    color: doc.color,
    teacher: doc.teacher,
    enrollment: doc.enrollment,
    enrollmentState: state,
    enrolledCount: students.length,
    blockedCount: students.filter((s) => s.blocked).length,
    isArchived: doc.isArchived,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };

  if (includeStudents) {
    payload.students = students.map((s) => ({
      student: s.student,
      enrolledAt: s.enrolledAt,
      method: s.method,
      status: s.status,
      blocked: s.blocked,
      blockedAt: s.blockedAt,
      blockReason: s.blockReason,
    }));
  }

  return payload;
}

/* ── authoring ──────────────────────────────────────────────────────────── */

export async function createSubject({ teacherId, input }) {
  const subject = new Subject({
    subjectCode: input.subjectCode,
    subjectName: input.subjectName,
    description: input.description || '',
    section: input.section,
    program: input.program || '',
    category: input.category || null,
    color: input.color || '#f97316',
    teacher: teacherId,
    enrollment: input.enrollment || {},
  });

  try {
    await subject.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw new ConflictError(`You already have ${subject.subjectCode} for section ${subject.section}`);
    }
    throw err;
  }

  return subject;
}

export async function listTeacherSubjects(teacherId) {
  const subjects = await Subject.find({ teacher: teacherId, isArchived: false })
    .sort({ createdAt: -1 })
    .populate('category', 'name color')
    .lean({ virtuals: false });

  if (!subjects.length) return [];

  const quizCounts = await Quiz.aggregate([
    { $match: { subject: { $in: subjects.map((s) => s._id) }, isArchived: false } },
    { $group: { _id: '$subject', count: { $sum: 1 } } },
  ]);
  const countMap = new Map(quizCounts.map((c) => [c._id.toString(), c.count]));

  return subjects.map((subject) => ({
    ...serialiseSubject(subject),
    quizCount: countMap.get(subject._id.toString()) || 0,
  }));
}

export async function getOwnedSubject(teacherId, subjectId, { role } = {}) {
  const subject = await Subject.findById(subjectId).populate('teacher', 'username email profile academic');
  if (!subject || subject.isArchived) throw new NotFoundError('Subject');
  if (role !== ROLES.ADMIN && subject.teacher?._id?.toString() !== teacherId.toString()) {
    throw new ForbiddenError('You can only manage your own subjects');
  }
  return subject;
}

/* ── QR codes ───────────────────────────────────────────────────────────── */

export async function issueEnrollmentCode(subject, origin, { expiresInHours } = {}) {
  const hours = expiresInHours || subject.enrollment?.qrExpiresInHours || 168;

  // Codes are random, but a short code space deserves an explicit collision check.
  let code = generateEnrollmentCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = await Subject.exists({ 'enrollmentCode.token': code, _id: { $ne: subject._id } });
    if (!taken) break;
    code = generateEnrollmentCode();
  }

  subject.enrollmentCode = {
    token: code,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    rotatedAt: new Date(),
  };
  await subject.save();

  const url = enrollmentUrl(origin, code);
  const qrDataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: { dark: '#0b0b12', light: '#ffffff' },
  });

  return {
    code,
    url,
    qrDataUrl,
    expiresAt: subject.enrollmentCode.expiresAt,
    expiresInHours: hours,
  };
}

/* ── student enrollment ─────────────────────────────────────────────────── */

export async function findSubjectByCode(rawCode) {
  const code = normalizeEnrollmentCode(rawCode);
  if (!code) throw new ValidationError('Enter the enrollment code from your teacher');

  const subject = await Subject.findOne({
    'enrollmentCode.token': code,
    isArchived: false,
  }).populate('teacher', 'username email profile academic');

  if (!subject) throw new NotFoundError('Enrollment code');
  if (!subject.enrollment?.allowQr) {
    throw new ForbiddenError('This subject has QR enrollment turned off');
  }
  if (!subject.enrollmentCode.expiresAt || subject.enrollmentCode.expiresAt < new Date()) {
    throw new ForbiddenError('This enrollment code has expired — ask your teacher for a new one');
  }

  return subject;
}

export async function previewEnrollment(rawCode, student) {
  const subject = await findSubjectByCode(rawCode);
  const existing = student?._id ? subject.enrollmentFor(student._id) : null;
  const joinedSection = student?.academic?.section;
  const sectionMismatch = Boolean(joinedSection && subject.section && joinedSection !== subject.section);

  return {
    sectionMismatch,
    studentSection: joinedSection || '',
    subject: {
      ...serialiseSubject(subject),
      teacherName: subject.teacher?.profile?.firstName
        ? [subject.teacher.profile.firstName, subject.teacher.profile.lastName].filter(Boolean).join(' ')
        : subject.teacher?.username,
      teacherDepartment: subject.teacher?.academic?.department || '',
      quizzes: await Quiz.countDocuments({ subject: subject._id, isPublished: true }),
    },
    alreadyEnrolled: Boolean(existing && existing.status === 'active'),
    pendingApproval: Boolean(existing && existing.status === 'pending'),
    blocked: Boolean(existing?.blocked),
    expiresAt: subject.enrollmentCode.expiresAt,
  };
}

export async function enrollStudent({ code, student }) {
  // Re-read without populating so we can mutate the embedded roster safely.
  const normalized = normalizeEnrollmentCode(code);
  const subject = await Subject.findOne({ 'enrollmentCode.token': normalized, isArchived: false });
  if (!subject) throw new NotFoundError('Enrollment code');

  if (!subject.enrollment?.allowQr) throw new ForbiddenError('This subject has QR enrollment turned off');
  if (!subject.enrollment?.isOpen) throw new ForbiddenError('This subject is closed for enrollment');
  if (!subject.enrollmentCode.expiresAt || subject.enrollmentCode.expiresAt < new Date()) {
    throw new ForbiddenError('This enrollment code has expired — ask your teacher for a new one');
  }

  if (student.academic?.section && subject.section && student.academic.section !== subject.section) {
    throw new ForbiddenError(
      `This code is for section ${subject.section}. Your account is in section ${student.academic.section}.`,
    );
  }

  const existing = subject.enrollmentFor(student._id);
  if (existing?.blocked) {
    throw new ForbiddenError('Your teacher has blocked you from this subject');
  }
  if (existing) {
    return {
      subject: serialiseSubject(subject),
      alreadyEnrolled: existing.status === 'active',
      pendingApproval: existing.status === 'pending',
    };
  }

  // Blocked students keep their seat until the teacher removes them.
  if (subject.students.length >= (subject.enrollment?.maxStudents || 50)) {
    throw new ForbiddenError('This subject is full — ask your teacher to raise the limit');
  }

  subject.students.push({
    student: student._id,
    enrolledAt: new Date(),
    method: 'qr',
    status: subject.enrollment?.requireApproval ? 'pending' : 'active',
  });
  await subject.save();

  return {
    subject: serialiseSubject(subject),
    alreadyEnrolled: false,
    pendingApproval: subject.enrollment?.requireApproval === true,
  };
}

export async function listStudentSubjects(studentId) {
  const subjects = await Subject.find({
    students: { $elemMatch: { student: studentId } },
    isArchived: false,
  })
    .sort({ createdAt: -1 })
    .populate('teacher', 'username profile academic')
    .populate('category', 'name color')
    .lean({ virtuals: false });

  if (!subjects.length) return [];

  const subjectIds = subjects.map((s) => s._id);
  const [quizCounts, resultRows] = await Promise.all([
    Quiz.aggregate([
      { $match: { subject: { $in: subjectIds }, isPublished: true } },
      { $group: { _id: '$subject', count: { $sum: 1 } } },
    ]),
    Quiz.aggregate([
      { $match: { subject: { $in: subjectIds } } },
      {
        $lookup: {
          from: 'results',
          let: { quizId: '$_id' },
          pipeline: [
            { $match: { $expr: { $and: [{ $eq: ['$quiz', '$$quizId'] }, { $eq: ['$student', studentId] }] } } },
            { $match: { status: { $ne: 'in_progress' } } },
            { $group: { _id: null, attempts: { $sum: 1 }, best: { $max: '$score.percentage' } } },
          ],
          as: 'mine',
        },
      },
      { $unwind: { path: '$mine', preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: '$subject',
          attempts: { $sum: { $ifNull: ['$mine.attempts', 0] } },
          bestScore: { $max: { $ifNull: ['$mine.best', 0] } },
        },
      },
    ]),
  ]);

  const countMap = new Map(quizCounts.map((c) => [c._id.toString(), c.count]));
  const resultMap = new Map(resultRows.map((r) => [r._id.toString(), r]));

  return subjects.map((subject) => {
    const row = subject.students.find((s) => s.student.toString() === studentId.toString());
    return {
      ...serialiseSubject(subject),
      teacherName: [subject.teacher?.profile?.firstName, subject.teacher?.profile?.lastName]
        .filter(Boolean)
        .join(' ') || subject.teacher?.username,
      myEnrollment: row
        ? {
            enrolledAt: row.enrolledAt,
            method: row.method,
            status: row.status,
            blocked: row.blocked,
            blockReason: row.blockReason,
          }
        : null,
      quizCount: countMap.get(subject._id.toString()) || 0,
      attempts: resultMap.get(subject._id.toString())?.attempts || 0,
      bestScore: round(resultMap.get(subject._id.toString())?.bestScore || 0),
    };
  });
}

/* ── blocking & rosters ─────────────────────────────────────────────────── */

export async function blockStudent({ teacherId, subjectId, studentId, reason = '', role }) {
  const subject = await getOwnedSubject(teacherId, subjectId, { role });
  const row = subject.enrollmentFor(studentId);
  if (!row) throw new NotFoundError('Enrollment');

  row.blocked = true;
  row.blockedAt = new Date();
  row.blockReason = reason;
  row.blockedBy = teacherId;
  await subject.save();

  return subject;
}

export async function unblockStudent({ teacherId, subjectId, studentId, role }) {
  const subject = await getOwnedSubject(teacherId, subjectId, { role });
  const row = subject.enrollmentFor(studentId);
  if (!row) throw new NotFoundError('Enrollment');

  row.blocked = false;
  row.blockedAt = null;
  row.blockReason = '';
  row.blockedBy = null;
  await subject.save();

  return subject;
}

export async function removeStudent({ teacherId, subjectId, studentId, role }) {
  const subject = await getOwnedSubject(teacherId, subjectId, { role });
  const before = subject.students.length;
  subject.students = subject.students.filter((s) => s.student.toString() !== studentId.toString());
  if (subject.students.length === before) throw new NotFoundError('Enrollment');
  await subject.save();
  return subject;
}

/* ── access control ─────────────────────────────────────────────────────── */

/**
 * Subject-scoped quizzes are only readable by enrolled, unblocked students of
 * that section. Throws when the student may not touch the quiz.
 */
export async function assertSubjectAccess(quiz, user) {
  if (!quiz?.subject || user?.role !== ROLES.STUDENT) return null;

  const subject = await Subject.findById(quiz.subject).select(
    'subjectCode subjectName section enrollment students',
  );
  if (!subject) return null;

  const row = subject.enrollmentFor(user._id);
  if (!row) {
    throw new ForbiddenError(
      `${subject.subjectCode} is limited to enrolled students — scan your teacher's QR code to join ${subject.section}.`,
    );
  }
  if (row.blocked) {
    throw new ForbiddenError(`Your teacher has blocked you from ${subject.subjectCode}`);
  }
  if (row.status === 'pending') {
    throw new ForbiddenError(`Your enrollment in ${subject.subjectCode} is waiting for teacher approval`);
  }
  return subject;
}

/** Ids of subjects the student is an active member of (used to scope lists). */
export async function enrolledSubjectIds(studentId) {
  const subjects = await Subject.find({
    students: { $elemMatch: { student: studentId, blocked: { $ne: true }, status: 'active' } },
    isArchived: false,
  }).distinct('_id');
  return subjects;
}

/* ── categories authored by teachers ────────────────────────────────────── */

export async function createCustomCategory({ teacherId, input }) {
  const existing = await Category.findOne({ name: input.name });
  if (existing) return { category: existing, reused: true };

  const category = await Category.create({
    name: input.name,
    description: input.description || `Created by a teacher for ${input.name} quizzes`,
    color: input.color || '#f97316',
    icon: input.icon || 'sparkles',
    createdBy: teacherId,
    isCustom: true,
    order: 100,
  });

  return { category, reused: false };
}

export default {
  generateEnrollmentCode,
  normalizeEnrollmentCode,
  enrollmentUrl,
  serialiseSubject,
  createSubject,
  listTeacherSubjects,
  getOwnedSubject,
  issueEnrollmentCode,
  findSubjectByCode,
  previewEnrollment,
  enrollStudent,
  listStudentSubjects,
  blockStudent,
  unblockStudent,
  removeStudent,
  assertSubjectAccess,
  enrolledSubjectIds,
  createCustomCategory,
};
