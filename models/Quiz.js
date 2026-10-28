import mongoose from 'mongoose';
import { questionSchema } from './Question.js';
import { QUIZ_DEFAULTS, QUIZ_LIMITS } from '../config/constants.js';
import { slugify, round, percentage } from '../utils/helpers.js';

const { Schema, model } = mongoose;

const settingsSchema = new Schema(
  {
    timePerQuestion: { type: Number, default: QUIZ_DEFAULTS.timePerQuestion, min: 10, max: 3600 },
    totalTimeLimit: { type: Number, default: null, min: 60, max: 43200 },
    randomizeQuestions: { type: Boolean, default: QUIZ_DEFAULTS.randomizeQuestions },
    randomizeOptions: { type: Boolean, default: QUIZ_DEFAULTS.randomizeOptions },
    showCorrectAnswers: { type: Boolean, default: QUIZ_DEFAULTS.showCorrectAnswers },
    allowRetakes: { type: Boolean, default: QUIZ_DEFAULTS.allowRetakes },
    maxAttempts: { type: Number, default: QUIZ_DEFAULTS.maxAttempts, min: 1, max: 20 },
    passingScore: { type: Number, default: QUIZ_DEFAULTS.passingScore, min: 0, max: 100 },
    showResultsImmediately: { type: Boolean, default: QUIZ_DEFAULTS.showResultsImmediately },
  },
  { _id: false },
);

const analyticsSchema = new Schema(
  {
    totalAttempts: { type: Number, default: 0, min: 0 },
    completedAttempts: { type: Number, default: 0, min: 0 },
    averageScore: { type: Number, default: 0, min: 0, max: 100 },
    averageTimeSpent: { type: Number, default: 0, min: 0 },
    completionRate: { type: Number, default: 0, min: 0, max: 100 },
    passRate: { type: Number, default: 0, min: 0, max: 100 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    ratingCount: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

const quizSchema = new Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: QUIZ_LIMITS.maxTitleLength },
    slug: { type: String, index: true },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    category: { type: Schema.Types.ObjectId, ref: 'Category', required: true, index: true },
    subject: { type: Schema.Types.ObjectId, ref: 'Subject', default: null, index: true },
    teacher: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    questions: {
      type: [questionSchema],
      validate: {
        validator: (arr) => arr.length > 0 && arr.length <= QUIZ_LIMITS.maxQuestions,
        message: `A quiz must have between 1 and ${QUIZ_LIMITS.maxQuestions} questions`,
      },
    },
    settings: { type: settingsSchema, default: () => ({}) },
    analytics: { type: analyticsSchema, default: () => ({}) },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium', index: true },
    tags: { type: [String], default: [], index: true },
    thumbnail: { type: String, default: '' },
    isPublished: { type: Boolean, default: false, index: true },
    isFeatured: { type: Boolean, default: false, index: true },
    isArchived: { type: Boolean, default: false, index: true },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

quizSchema.index({ title: 'text', description: 'text', tags: 'text' });
quizSchema.index({ isPublished: 1, createdAt: -1 });
quizSchema.index({ teacher: 1, createdAt: -1 });

quizSchema.virtual('questionCount').get(function count() {
  return this.questions?.length || 0;
});

quizSchema.virtual('totalPoints').get(function total() {
  return (this.questions || []).reduce((sum, q) => sum + (q.points || 0), 0);
});

quizSchema.virtual('estimatedMinutes').get(function estimate() {
  if (this.settings?.totalTimeLimit) return Math.round(this.settings.totalTimeLimit / 60);
  const seconds = (this.questions || []).reduce(
    (sum, q) => sum + (q.timeLimit || this.settings?.timePerQuestion || 60),
    0,
  );
  return Math.max(1, Math.round(seconds / 60));
});

quizSchema.pre('validate', function setSlug(next) {
  if (this.isModified('title') || !this.slug) {
    const base = slugify(this.title);
    this.slug = `${base}-${this._id.toString().slice(-5)}`;
  }
  if (this.isModified('isPublished')) {
    this.publishedAt = this.isPublished ? this.publishedAt || new Date() : null;
  }
  next();
});

/** Recalculate derived analytics from aggregate inputs. */
quizSchema.methods.applyAnalytics = function applyAnalytics({ averageScore, averageTimeSpent, passRate }) {
  const a = this.analytics;
  a.averageScore = round(averageScore ?? a.averageScore);
  a.averageTimeSpent = Math.round(averageTimeSpent ?? a.averageTimeSpent);
  a.passRate = percentage(passRate ?? a.passRate, 100) || 0;
  a.completionRate = a.totalAttempts
    ? round((a.completedAttempts / a.totalAttempts) * 100)
    : 0;
  return this;
};

export const Quiz = model('Quiz', quizSchema);
export default Quiz;
