import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { NOTIFICATION_TYPES, ROLES } from '../config/constants.js';
import { NotFoundError } from '../utils/errors.js';
import { getPagination, paginationMeta, serialize } from '../utils/helpers.js';
import { sendQuizPublishedEmail, sendResultEmail } from './emailService.js';
import logger from '../utils/logger.js';

/** Create an in-app notification, optionally mirrored to email. */
export async function createNotification({
  userId,
  type = NOTIFICATION_TYPES.SYSTEM,
  title,
  message,
  link = '',
  relatedQuiz = null,
  relatedResult = null,
  email = null,
  meta = {},
}) {
  const notification = await Notification.create({
    user: userId,
    type,
    title,
    message,
    link,
    relatedQuiz,
    relatedResult,
    meta,
  });

  // Best-effort realtime push; never block on a socket layer import failure.
  import('../sockets/realtime.js')
    .then(({ pushToUser }) =>
      pushToUser(userId.toString(), 'notification:new', {
        notification: serialize(notification),
      }),
    )
    .catch(() => {});

  if (email) {
    const user = await User.findById(userId).select('email preferences username');
    if (user && user.preferences?.emailNotifications !== false) {
      const result = await email(user);
      if (result?.success) {
        notification.emailSent = true;
        await notification.save();
      }
    }
  }

  return notification;
}

export async function notifyResultPublished({ user, result, quizTitle }) {
  return createNotification({
    userId: user._id || user,
    type: NOTIFICATION_TYPES.RESULT_PUBLISHED,
    title: 'Result published',
    message: `Your attempt for “${quizTitle}” scored ${result.score.percentage}%.`,
    link: `/results/${result._id}`,
    relatedQuiz: result.quiz,
    relatedResult: result._id,
    email: (recipient) =>
      sendResultEmail(recipient, {
        quizTitle,
        percentage: result.score.percentage,
        passed: result.isPassed,
        resultId: result._id.toString(),
      }),
  });
}

/** Notify students (optionally limited) that a quiz went live. */
export async function notifyQuizPublished({ quiz, teacher, audienceLimit = 200 }) {
  const students = await User.find({ role: ROLES.STUDENT, 'security.isActive': true })
    .select('_id')
    .limit(audienceLimit)
    .lean();

  if (!students.length) return [];

  const docs = students.map((s) => ({
    user: s._id,
    type: NOTIFICATION_TYPES.QUIZ_AVAILABLE,
    title: 'New quiz available',
    message: `${teacher.profile?.firstName || teacher.username} published “${quiz.title}”.`,
    link: `/quiz/${quiz._id}`,
    relatedQuiz: quiz._id,
  }));

  try {
    const created = await Notification.insertMany(docs, { ordered: false });
    logger.info(`Notified ${created.length} students about quiz ${quiz._id}`);
    return created;
  } catch (err) {
    logger.warn(`Quiz publish notifications partially failed: ${err.message}`);
    return [];
  }
}

/** Send reminders to students who have not attempted a published quiz. */
export async function sendQuizReminder(quiz, { limit = 50 } = {}) {
  const { Result } = await import('../models/Result.js');
  const attempted = await Result.distinct('student', { quiz: quiz._id });
  const students = await User.find({
    role: ROLES.STUDENT,
    'security.isActive': true,
    _id: { $nin: attempted },
  })
    .select('email username preferences profile')
    .limit(limit);

  const results = await Promise.allSettled(
    students
      .filter((s) => s.preferences?.emailNotifications !== false)
      .map((s) => sendQuizPublishedEmail(s, {
        quizTitle: quiz.title,
        quizId: quiz._id.toString(),
        teacherName: 'Your teacher',
      }).then(() => createNotification({
        userId: s._id,
        type: NOTIFICATION_TYPES.QUIZ_REMINDER,
        title: 'Quiz reminder',
        message: `“${quiz.title}” is still open.`,
        link: `/quiz/${quiz._id}`,
        relatedQuiz: quiz._id,
      }))),
  );

  return { sent: results.filter((r) => r.status === 'fulfilled').length, failed: results.filter((r) => r.status === 'rejected').length };
}

export async function listNotifications(userId, query = {}) {
  const { page, limit, skip } = getPagination(query, { defaultLimit: 20 });
  const filter = { user: userId };
  if (query.unread === 'true') filter.isRead = false;

  const [items, total, unread] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ user: userId, isRead: false }),
  ]);

  return {
    items: items.map(serialize),
    unread,
    meta: paginationMeta({ page, limit, total }),
  };
}

export async function markNotificationRead(userId, notificationId) {
  const notification = await Notification.findOne({ _id: notificationId, user: userId });
  if (!notification) throw new NotFoundError('Notification');
  notification.markRead();
  await notification.save();
  return notification;
}

export async function markAllRead(userId) {
  const { modifiedCount } = await Notification.updateMany(
    { user: userId, isRead: false },
    { $set: { isRead: true, readAt: new Date() } },
  );
  return modifiedCount;
}

export default {
  createNotification,
  notifyResultPublished,
  notifyQuizPublished,
  sendQuizReminder,
  listNotifications,
  markNotificationRead,
  markAllRead,
};
