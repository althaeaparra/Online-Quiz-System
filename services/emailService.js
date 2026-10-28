import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

/**
 * Nodemailer wrapper with designed HTML templates.
 *
 * With SMTP_HOST unset (or NODE_ENV=test) it uses the JSON transport: messages
 * are rendered and logged instead of sent, so development needs no credentials.
 */

let transporter = null;

export function getTransporter() {
  if (transporter) return transporter;

  const useJson = !process.env.SMTP_HOST || process.env.NODE_ENV === 'test';

  transporter = useJson
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
          : undefined,
        pool: true,
        maxConnections: 3,
      });

  return transporter;
}

export const appUrl = () => (process.env.APP_URL || 'http://localhost:5000').replace(/\/$/, '');

/* ── layout ─────────────────────────────────────────────────────────────── */

const BRAND = process.env.APP_NAME || 'CITE BrainCheck';

export function renderEmail({ preheader = '', heading, body, ctaLabel, ctaUrl, footer }) {
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#0b0a09;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f5efe8;">
    <span style="display:none;opacity:0;color:transparent;height:0;width:0;overflow:hidden">${preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0a09;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:linear-gradient(180deg,#1a1613 0%,#12100d 100%);border:1px solid #3a2f26;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 8px 32px;">
                <div style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(249,115,22,0.18);border:1px solid rgba(249,115,22,0.4);color:#fbbf24;font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:600;">
                  ${BRAND}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0 32px;">
                <h1 style="margin:0 0 12px 0;font-size:24px;line-height:1.3;color:#fdf8f2;font-weight:700;">${heading}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px 32px;font-size:15px;line-height:1.7;color:#e0d2c4;">${body}</td>
            </tr>
            ${
              ctaLabel && ctaUrl
                ? `<tr><td style="padding:16px 32px 8px 32px;">
                    <a href="${ctaUrl}" style="display:inline-block;padding:12px 22px;border-radius:12px;background:linear-gradient(135deg,#f97316,#ef4444);color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;">${ctaLabel}</a>
                   </td></tr>`
                : ''
            }
            <tr>
              <td style="padding:24px 32px 32px 32px;border-top:1px solid #3a2f26;margin-top:24px;">
                <p style="margin:16px 0 0 0;font-size:12px;line-height:1.6;color:#b09a86;">
                  ${footer || `You are receiving this email because you have a ${BRAND} account.`}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/* ── sending ────────────────────────────────────────────────────────────── */

export async function sendMail({ to, subject, html, text }) {
  try {
    const info = await getTransporter().sendMail({
      from: process.env.MAIL_FROM || `${BRAND} <no-reply@citebraincheck.dev>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    });

    if (info.message?.toString?.().includes('jsonTransport') || !process.env.SMTP_HOST) {
      logger.info(`Email preview (not sent) → ${to} · ${subject}`);
    } else {
      logger.info(`Email sent → ${to} · ${subject} · ${info.messageId}`);
    }
    return { success: true, messageId: info.messageId };
  } catch (err) {
    // Email failures must never fail the user's request.
    logger.error(`Email failed → ${to} · ${subject}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export const sendWelcomeEmail = async (user) => {
  const name = user.profile?.firstName || user.username;
  return sendMail({
    to: user.email,
    subject: `Welcome to ${BRAND}, ${name}!`,
    html: renderEmail({
      preheader: 'Your account is ready — start your first quiz.',
      heading: `Welcome aboard, ${name} 🎉`,
      body: `<p style="margin:0 0 12px 0;">Your ${BRAND} account is ready. Browse the library, take a quiz and watch your streak grow.</p>
             <p style="margin:0;color:#b09a86;font-size:14px;">Tip: quizzes marked <strong style="color:#fbbf24;">featured</strong> are hand-picked by your teachers.</p>`,
      ctaLabel: 'Explore quizzes',
      ctaUrl: `${appUrl()}/#/quizzes`,
    }),
  });
};

export const sendVerificationEmail = async (user, token) => {
  const url = `${appUrl()}/#/verify-email?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Verify your email address',
    html: renderEmail({
      preheader: 'Confirm your email to unlock all features.',
      heading: 'Confirm your email',
      body: `<p style="margin:0 0 12px 0;">Hi ${user.profile?.firstName || user.username}, tap the button below to verify your email address. This link expires in 24 hours.</p>
             <p style="margin:0;color:#b09a86;font-size:13px;">If you didn't create an account, you can ignore this email.</p>`,
      ctaLabel: 'Verify email',
      ctaUrl: url,
    }),
  });
};

export const sendPasswordResetEmail = async (user, token) => {
  const url = `${appUrl()}/#/reset-password?token=${token}`;
  return sendMail({
    to: user.email,
    subject: 'Reset your password',
    html: renderEmail({
      preheader: 'Reset link valid for 60 minutes.',
      heading: 'Reset your password',
      body: `<p style="margin:0 0 12px 0;">We received a request to reset the password for <strong>${user.username}</strong>. This link expires in 60 minutes.</p>
             <p style="margin:0;color:#b09a86;font-size:13px;">Didn't request this? Your password is unchanged — no action needed.</p>`,
      ctaLabel: 'Choose a new password',
      ctaUrl: url,
    }),
  });
};

export const sendResultEmail = async (user, { quizTitle, percentage, passed, resultId }) => {
  const tone = passed ? '#34d399' : '#fb7185';
  return sendMail({
    to: user.email,
    subject: `Your result for “${quizTitle}”`,
    html: renderEmail({
      preheader: `You scored ${percentage}%.`,
      heading: passed ? 'Nice work — you passed! 🎯' : 'Result published',
      body: `<p style="margin:0 0 16px 0;">Your attempt for <strong>${quizTitle}</strong> has been graded.</p>
             <div style="padding:16px 20px;border-radius:14px;background:#191411;border:1px solid #3a2f26;">
               <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#b09a86;font-weight:600;">Score</div>
               <div style="font-size:32px;font-weight:700;color:${tone};margin-top:4px;">${percentage}%</div>
               <div style="font-size:13px;color:#b09a86;margin-top:2px;">${passed ? 'Passed' : 'Below the passing score'}</div>
             </div>`,
      ctaLabel: 'Review answers',
      ctaUrl: `${appUrl()}/#/results/${resultId}`,
    }),
  });
};

export const sendQuizReminderEmail = async (user, { quizTitle, quizId }) =>
  sendMail({
    to: user.email,
    subject: `Reminder: “${quizTitle}” is waiting`,
    html: renderEmail({
      preheader: 'Pick up where you left off.',
      heading: 'A quiz is waiting for you',
      body: `<p style="margin:0 0 12px 0;"><strong>${quizTitle}</strong> is still open. Keep your streak alive — it only takes a few minutes.</p>`,
      ctaLabel: 'Start quiz',
      ctaUrl: `${appUrl()}/#/quiz/${quizId}`,
    }),
  });

export const sendQuizPublishedEmail = async (user, { quizTitle, quizId, teacherName }) =>
  sendMail({
    to: user.email,
    subject: `New quiz: ${quizTitle}`,
    html: renderEmail({
      preheader: `${teacherName} published a new quiz.`,
      heading: 'New quiz published',
      body: `<p style="margin:0 0 12px 0;"><strong>${teacherName}</strong> just published <strong>${quizTitle}</strong>. Be among the first to try it.</p>`,
      ctaLabel: 'Take the quiz',
      ctaUrl: `${appUrl()}/#/quiz/${quizId}`,
    }),
  });

export default {
  getTransporter,
  renderEmail,
  sendMail,
  sendWelcomeEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendResultEmail,
  sendQuizReminderEmail,
  sendQuizPublishedEmail,
};
