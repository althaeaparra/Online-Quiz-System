import mongoose from 'mongoose';
import { NOTIFICATION_TYPE_VALUES, NOTIFICATION_TYPES } from '../config/constants.js';

const { Schema, model } = mongoose;

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: NOTIFICATION_TYPE_VALUES,
      default: NOTIFICATION_TYPES.SYSTEM,
      index: true,
    },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    message: { type: String, required: true, trim: true, maxlength: 1000 },
    link: { type: String, default: '' },
    relatedQuiz: { type: Schema.Types.ObjectId, ref: 'Quiz', default: null },
    relatedResult: { type: Schema.Types.ObjectId, ref: 'Result', default: null },
    isRead: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
    emailSent: { type: Boolean, default: false },
    pushSent: { type: Boolean, default: false },
    meta: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }); // 90-day retention

notificationSchema.methods.markRead = function markRead() {
  if (!this.isRead) {
    this.isRead = true;
    this.readAt = new Date();
  }
  return this;
};

export const Notification = model('Notification', notificationSchema);
export default Notification;
