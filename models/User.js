import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { ROLES, ROLE_VALUES } from '../config/constants.js';

const { Schema, model } = mongoose;

const profileSchema = new Schema(
  {
    firstName: { type: String, trim: true, maxlength: 50, default: '' },
    lastName: { type: String, trim: true, maxlength: 50, default: '' },
    avatar: { type: String, trim: true, default: '' },
    bio: { type: String, trim: true, maxlength: 500, default: '' },
    timezone: { type: String, trim: true, default: 'UTC' },
    language: { type: String, trim: true, default: 'en' },
  },
  { _id: false },
);

const academicSchema = new Schema(
  {
    // Student identifiers
    studentId: { type: String, trim: true, uppercase: true, maxlength: 30, default: '' },
    yearLevel: { type: String, trim: true, maxlength: 20, default: '' },
    section: { type: String, trim: true, uppercase: true, maxlength: 40, default: '' },
    program: { type: String, trim: true, maxlength: 80, default: '' },
    // Teacher identifiers
    teacherId: { type: String, trim: true, uppercase: true, maxlength: 30, default: '' },
    department: { type: String, trim: true, maxlength: 80, default: '' },
  },
  { _id: false },
);

const preferencesSchema = new Schema(
  {
    theme: { type: String, enum: ['system', 'light', 'dark'], default: 'system' },
    emailNotifications: { type: Boolean, default: true },
    pushNotifications: { type: Boolean, default: true },
    privacy: {
      showOnLeaderboard: { type: Boolean, default: true },
      shareStats: { type: Boolean, default: false },
    },
  },
  { _id: false },
);

const statsSchema = new Schema(
  {
    quizzesTaken: { type: Number, default: 0, min: 0 },
    quizzesCreated: { type: Number, default: 0, min: 0 },
    averageScore: { type: Number, default: 0, min: 0, max: 100 },
    totalPoints: { type: Number, default: 0, min: 0 },
    currentStreak: { type: Number, default: 0, min: 0 },
    longestStreak: { type: Number, default: 0, min: 0 },
    lastActivityAt: { type: Date, default: null },
  },
  { _id: false },
);

const securitySchema = new Schema(
  {
    isActive: { type: Boolean, default: true },
    emailVerified: { type: Boolean, default: false },
    loginAttempts: { type: Number, default: 0, min: 0 },
    lockUntil: { type: Date, default: null },
    verificationToken: { type: String, select: false, default: null },
    verificationExpires: { type: Date, select: false, default: null },
    resetToken: { type: String, select: false, default: null },
    resetExpires: { type: Date, select: false, default: null },
    passwordChangedAt: { type: Date, default: null },
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    username: {
      type: String,
      required: [true, 'Username is required'],
      unique: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: [/^[a-zA-Z0-9_.-]+$/, 'Username contains invalid characters'],
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Enter a valid email address'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: 8,
      select: false,
    },
    role: { type: String, enum: ROLE_VALUES, default: ROLES.STUDENT, index: true },
    profile: { type: profileSchema, default: () => ({}) },
    academic: { type: academicSchema, default: () => ({}) },
    preferences: { type: preferencesSchema, default: () => ({}) },
    stats: { type: statsSchema, default: () => ({}) },
    security: { type: securitySchema, default: () => ({}) },
    lastLogin: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret.password;
        delete ret.__v;
        delete ret.security?.verificationToken;
        delete ret.security?.resetToken;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

userSchema.index({ role: 1, createdAt: -1 });
userSchema.index({ 'academic.studentId': 1 }, { sparse: true });
userSchema.index({ 'academic.section': 1 }, { sparse: true });
userSchema.index({ 'stats.averageScore': -1 });
userSchema.index({ username: 'text', email: 'text', 'profile.firstName': 'text', 'profile.lastName': 'text' });

userSchema.virtual('fullName').get(function fullName() {
  return [this.profile?.firstName, this.profile?.lastName].filter(Boolean).join(' ') || this.username;
});

userSchema.virtual('isLocked').get(function isLocked() {
  return Boolean(this.security?.lockUntil && this.security.lockUntil > Date.now());
});

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  const rounds = Number(process.env.BCRYPT_ROUNDS || 12);
  this.password = await bcrypt.hash(this.password, rounds);
  if (!this.isNew) this.security.passwordChangedAt = new Date();
  return next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  const maxAttempts = 5;
  this.security.loginAttempts += 1;
  if (this.security.loginAttempts >= maxAttempts) {
    this.security.lockUntil = new Date(Date.now() + 15 * 60 * 1000);
    this.security.loginAttempts = 0;
  }
  await this.save();
};

userSchema.methods.resetLoginAttempts = async function resetLoginAttempts() {
  if (this.security.loginAttempts || this.security.lockUntil) {
    this.security.loginAttempts = 0;
    this.security.lockUntil = null;
    await this.save();
  }
};

userSchema.methods.createVerificationToken = function createVerificationToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  this.security.verificationToken = crypto.createHash('sha256').update(raw).digest('hex');
  this.security.verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return raw;
};

userSchema.methods.createPasswordResetToken = function createPasswordResetToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  this.security.resetToken = crypto.createHash('sha256').update(raw).digest('hex');
  this.security.resetExpires = new Date(Date.now() + 60 * 60 * 1000);
  return raw;
};

userSchema.statics.hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export const User = model('User', userSchema);
export default User;
