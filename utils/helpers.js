import crypto from 'node:crypto';

/** Pagination params with hard caps so a client cannot ask for 1M rows. */
export function getPagination(query = {}, { defaultLimit = 12, maxLimit = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

export function paginationMeta({ page, limit, total }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}

/** Strip Mongo internals and normalize ids for API responses. */
export function serialize(doc) {
  if (!doc) return null;
  if (Array.isArray(doc)) return doc.map(serialize);
  const obj = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : { ...doc };
  delete obj.__v;
  delete obj.password;
  return obj;
}

export const slugify = (value = '') =>
  value
    .toString()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

/** Convert "15m" / "7d" / "3600" to seconds (used for Redis TTLs). */
export function durationToSeconds(value, fallback = 900) {
  if (!value) return fallback;
  if (/^\d+$/.test(String(value))) return Number(value);
  const match = String(value).match(/^(\d+)\s*(ms|s|m|h|d)$/i);
  if (!match) return fallback;
  const multipliers = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  return Math.floor(Number(match[1]) * multipliers[match[2].toLowerCase()]);
}

export const pick = (source = {}, keys = []) =>
  keys.reduce((acc, key) => {
    if (source[key] !== undefined) acc[key] = source[key];
    return acc;
  }, {});

export const omitEmpty = (obj = {}) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));

export function shuffle(array = []) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Stable pseudo-random order for a given seed (keeps attempts consistent). */
export function seededShuffle(array = [], seed = '') {
  const copy = [...array];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const next = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return Math.abs(h) / 2147483647;
  };
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
};

export const percentage = (part, total) => (total > 0 ? round((part / total) * 100) : 0);

export function groupBy(items = [], keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    (acc[key] ||= []).push(item);
    return acc;
  }, {});
}

export function formatDuration(seconds = 0) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${rest}s`;
  return `${rest}s`;
}

/** RFC 4180-style CSV from a matrix of cells. */
export function toCsv(rows = []) {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell === null || cell === undefined ? '' : String(cell);
          return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(','),
    )
    .join('\r\n');
}

/** Only these fields are ever returned for a user. */
export function publicUser(user) {
  if (!user) return null;
  const source = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    id: source._id?.toString?.() || source.id,
    username: source.username,
    email: source.email,
    role: source.role,
    profile: source.profile,
    academic: source.academic,
    preferences: source.preferences,
    stats: source.stats,
    emailVerified: source.security?.emailVerified ?? false,
    isActive: source.security?.isActive ?? true,
    lastLogin: source.lastLogin,
    createdAt: source.createdAt,
  };
}

export default {
  getPagination,
  paginationMeta,
  serialize,
  slugify,
  randomToken,
  durationToSeconds,
  pick,
  omitEmpty,
  shuffle,
  seededShuffle,
  round,
  percentage,
  groupBy,
  formatDuration,
  toCsv,
  publicUser,
};
