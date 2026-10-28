/**
 * Create (or promote) a single administrator — the first-account step for a
 * real deployment, without the demo cohort that `npm run seed` installs.
 *
 *   npm run create-admin -- --email head@cite.edu --password 'long-secret' --name "Ada Reyes"
 *
 * Or from the environment (handy in Docker):
 *
 *   ADMIN_EMAIL=head@cite.edu ADMIN_PASSWORD=long-secret npm run create-admin
 *
 * The password is never echoed. Running it again with an existing email
 * promotes that account to admin and re-activates it.
 */
import 'dotenv/config';
import { connectDB, disconnectDB } from '../config/db.js';
import { User } from '../models/User.js';
import { ROLES } from '../config/constants.js';
import logger from '../utils/logger.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    args[name] = value;
  }
  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const email = (args.email || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = args.password || process.env.ADMIN_PASSWORD || '';
  const username = (args.username || process.env.ADMIN_USERNAME || email.split('@')[0] || '').trim();
  const name = (args.name || process.env.ADMIN_NAME || '').trim();

  const problems = [];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) problems.push('a valid --email (or ADMIN_EMAIL)');
  if (!password || password.length < 8) problems.push('a --password (or ADMIN_PASSWORD) of at least 8 characters');
  if (!username) problems.push('a --username (or ADMIN_USERNAME)');
  if (problems.length) {
    logger.error(`create-admin needs ${problems.join(', ')}`);
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && /^(password|password123|admin)$/i.test(password)) {
    logger.error('That password is a well-known placeholder — choose a real one.');
    process.exit(1);
  }

  await connectDB({ allowMemory: process.env.USE_MEMORY_DB === 'true' });

  const [firstName, ...rest] = name.split(/\s+/).filter(Boolean);
  const existing = await User.findOne({ $or: [{ email }, { username }] }).select('+security');

  if (existing) {
    const before = existing.role;
    existing.role = ROLES.ADMIN;
    existing.security.isActive = true;
    existing.security.emailVerified = true;
    existing.security.loginAttempts = 0;
    existing.security.lockUntil = null;
    // Only replace the password when one is supplied for an existing account.
    existing.password = password;
    if (firstName) {
      existing.profile.firstName = firstName;
      existing.profile.lastName = rest.join(' ');
    }
    await existing.save();
    logger.info(`${existing.email} is an administrator (${before} → admin, password reset).`);
  } else {
    const created = await User.create({
      username,
      email,
      password,
      role: ROLES.ADMIN,
      profile: { firstName: firstName || '', lastName: rest.join(' ') },
      academic: { department: 'CITE' },
      security: { emailVerified: true },
    });
    logger.info(`Administrator created: ${created.email} (${created.username})`);
  }

  logger.info('Sign in at /#/admin/login');
  await disconnectDB();
}

run().catch(async (err) => {
  logger.error(`create-admin failed: ${err.stack || err.message}`);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
