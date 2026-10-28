import mongoose from 'mongoose';
import { QUESTION_TYPE_VALUES } from '../config/constants.js';

const { Schema, model } = mongoose;

/**
 * Questions are stored as an embedded sub-document array on Quiz. That keeps a
 * quiz attempt atomic (one read, one write) and avoids N+1 queries while taking
 * a quiz. The standalone `Question` model is exported for internal tooling and
 * migrations that need to query questions across quizzes.
 */

export const optionSchema = new Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 500 },
  },
  { _id: false },
);

export const questionSchema = new Schema(
  {
    type: {
      type: String,
      enum: QUESTION_TYPE_VALUES,
      required: true,
      default: 'multiple_choice',
    },
    question: { type: String, required: [true, 'Question text is required'], trim: true, maxlength: 2000 },
    options: { type: [optionSchema], default: [] },
    /**
     * Shape depends on `type`:
     *  - multiple_choice → number (option index) or array of indexes
     *  - true_false      → boolean
     *  - short_answer    → string or array of accepted strings
     *  - essay           → null (graded manually)
     */
    correctAnswer: { type: Schema.Types.Mixed, default: null },
    points: { type: Number, default: 1, min: 1, max: 100 },
    timeLimit: { type: Number, default: null, min: 5, max: 3600 },
    explanation: { type: String, trim: true, maxlength: 1000, default: '' },
    difficulty: { type: String, enum: ['easy', 'medium', 'hard'], default: 'medium' },
    imageUrl: { type: String, trim: true, default: '' },
    order: { type: Number, default: 0 },
  },
  { _id: true },
);

questionSchema.virtual('isAutoGraded').get(function isAutoGraded() {
  return this.type !== 'essay';
});

export const Question = model('Question', questionSchema);
export default Question;
