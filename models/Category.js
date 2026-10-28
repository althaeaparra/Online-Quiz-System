import mongoose from 'mongoose';
import { slugify } from '../utils/helpers.js';

const { Schema, model } = mongoose;

const categorySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 60, unique: true },
    slug: { type: String, unique: true, index: true },
    description: { type: String, trim: true, maxlength: 300, default: '' },
    icon: { type: String, trim: true, maxlength: 40, default: 'sparkles' },
    color: {
      type: String,
      trim: true,
      default: '#6366f1',
      match: [/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Color must be a hex value'],
    },
    parentCategory: { type: Schema.Types.ObjectId, ref: 'Category', default: null, index: true },
    // Categories invented by teachers inside the quiz builder.
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    isCustom: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true, index: true },
    order: { type: Number, default: 0 },
    quizCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

categorySchema.pre('validate', function setSlug(next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name);
  }
  next();
});

categorySchema.virtual('children', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parentCategory',
});

export const Category = model('Category', categorySchema);
export default Category;
