import mongoose from 'mongoose';
import crypto from 'node:crypto';

const { Schema, model } = mongoose;

const enrollmentSchema = new Schema(
  {
    allowQr: { type: Boolean, default: true },
    isOpen: { type: Boolean, default: true },
    maxStudents: { type: Number, default: 50, min: 1, max: 500 },
    requireApproval: { type: Boolean, default: false },
    qrExpiresInHours: { type: Number, default: 168, min: 1, max: 8760 },
  },
  { _id: false },
);

const enrolledStudentSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    enrolledAt: { type: Date, default: Date.now },
    method: { type: String, enum: ['qr', 'manual', 'code'], default: 'qr' },
    status: { type: String, enum: ['active', 'pending'], default: 'active' },
    blocked: { type: Boolean, default: false },
    blockedAt: { type: Date, default: null },
    blockReason: { type: String, trim: true, maxlength: 200, default: '' },
    blockedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false },
);

const enrollmentCodeSchema = new Schema(
  {
    token: { type: String, default: null, index: true },
    createdAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    rotatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const subjectSchema = new Schema(
  {
    subjectCode: {
      type: String,
      required: [true, 'Subject code is required'],
      trim: true,
      uppercase: true,
      maxlength: 20,
      match: [/^[A-Z0-9-]+$/, 'Subject code may only contain letters, numbers and dashes'],
    },
    subjectName: { type: String, required: [true, 'Subject name is required'], trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    teacher: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    section: { type: String, required: [true, 'Section is required'], trim: true, uppercase: true, maxlength: 40 },
    program: { type: String, trim: true, maxlength: 80, default: '' },
    category: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    color: {
      type: String,
      trim: true,
      default: '#f97316',
      match: [/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex value'],
    },
    enrollment: { type: enrollmentSchema, default: () => ({}) },
    enrollmentCode: { type: enrollmentCodeSchema, default: () => ({}) },
    students: { type: [enrolledStudentSchema], default: [] },
    isArchived: { type: Boolean, default: false, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.__v;
        // Never leak the raw enrollment token in list responses.
        if (ret.enrollmentCode) delete ret.enrollmentCode.token;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

// A subject code is unique per teacher, per section.
subjectSchema.index({ teacher: 1, subjectCode: 1, section: 1 }, { unique: true });
subjectSchema.index({ 'students.student': 1 });
subjectSchema.index({ subjectName: 'text', description: 'text' });

subjectSchema.virtual('enrolledCount').get(function enrolledCount() {
  return (this.students || []).filter((s) => !s.blocked).length;
});

/** Generate (or rotate) the enrollment token used to build the QR code. */
subjectSchema.methods.rotateEnrollmentCode = function rotateEnrollmentCode({ expiresInHours } = {}) {
  const hours = expiresInHours || this.enrollment?.qrExpiresInHours || 168;
  this.enrollmentCode = {
    token: crypto.randomBytes(18).toString('base64url'),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
    rotatedAt: new Date(),
  };
  if (this.enrollmentCode.token) {
    // Keep the raw token out of `toJSON` while still returning it from the endpoint.
    this.$locals.rawToken = this.enrollmentCode.token;
  }
  return this.enrollmentCode.token;
};

subjectSchema.methods.enrollmentState = function enrollmentState() {
  const code = this.enrollmentCode || {};
  const active = Boolean(code.token && code.expiresAt && code.expiresAt > new Date());
  return {
    active,
    expiresAt: code.expiresAt || null,
    createdAt: code.createdAt || null,
  };
};

/** Find the enrollment row for a student (active, pending, blocked or removed). */
subjectSchema.methods.enrollmentFor = function enrollmentFor(studentId) {
  const id = studentId.toString();
  return (this.students || []).find((s) => s.student.toString() === id) || null;
};

export const Subject = model('Subject', subjectSchema);
export default Subject;
