import mongoose from 'mongoose';
import { RESULT_STATUS } from '../config/constants.js';
import { round, percentage } from '../utils/helpers.js';

const { Schema, model } = mongoose;

const answerSchema = new Schema(
  {
    question: { type: Schema.Types.ObjectId, required: true },
    questionText: { type: String, default: '' },
    type: { type: String, default: 'multiple_choice' },
    studentAnswer: { type: Schema.Types.Mixed, default: null },
    isCorrect: { type: Boolean, default: null },
    pointsEarned: { type: Number, default: 0, min: 0 },
    maxPoints: { type: Number, default: 0, min: 0 },
    needsManualGrading: { type: Boolean, default: false },
    feedback: { type: String, trim: true, maxlength: 1000, default: '' },
  },
  { _id: false },
);

const scoreSchema = new Schema(
  {
    totalScore: { type: Number, default: 0, min: 0 },
    maxScore: { type: Number, default: 0, min: 0 },
    percentage: { type: Number, default: 0, min: 0, max: 100 },
    passed: { type: Boolean, default: false },
  },
  { _id: false },
);

const resultSchema = new Schema(
  {
    quiz: { type: Schema.Types.ObjectId, ref: 'Quiz', required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    teacher: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    answers: { type: [answerSchema], default: [] },
    score: { type: scoreSchema, default: () => ({}) },
    timeSpent: { type: Number, default: 0, min: 0 }, // seconds
    attemptNumber: { type: Number, default: 1, min: 1 },
    status: {
      type: String,
      enum: Object.values(RESULT_STATUS),
      default: RESULT_STATUS.IN_PROGRESS,
      index: true,
    },
    passingScore: { type: Number, default: 60, min: 0, max: 100 },
    isPassed: { type: Boolean, default: false },
    startedAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
    gradedAt: { type: Date, default: null },
    gradedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    ipAddress: { type: String, default: '' },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// One attempt number per student per quiz.
resultSchema.index({ quiz: 1, student: 1, attemptNumber: 1 }, { unique: true });
resultSchema.index({ student: 1, createdAt: -1 });
resultSchema.index({ quiz: 1, status: 1, completedAt: -1 });

resultSchema.virtual('needsGrading').get(function needsGrading() {
  return this.answers.some((a) => a.needsManualGrading);
});

resultSchema.virtual('correctCount').get(function correctCount() {
  return this.answers.filter((a) => a.isCorrect === true).length;
});

resultSchema.methods.recalculate = function recalculate() {
  const maxScore = this.answers.reduce((sum, a) => sum + (a.maxPoints || 0), 0);
  const totalScore = this.answers.reduce((sum, a) => sum + (a.pointsEarned || 0), 0);
  this.score.maxScore = round(maxScore);
  this.score.totalScore = round(totalScore);
  this.score.percentage = percentage(totalScore, maxScore);
  this.score.passed = this.score.percentage >= (this.passingScore ?? 60);
  this.isPassed = this.score.passed;
  return this;
};

/** Quizzes may be deleted; results must survive. */
resultSchema.pre('save', function computeOnSave(next) {
  if (this.isModified('answers') || this.isModified('passingScore')) this.recalculate();
  next();
});

export const Result = model('Result', resultSchema);
export default Result;
