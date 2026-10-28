import {
  durationToSeconds,
  percentage,
  getPagination,
  paginationMeta,
  round,
  seededShuffle,
  slugify,
  formatDuration,
} from '../../utils/helpers.js';

describe('helper utilities', () => {
  test('pagination clamps page and limit', () => {
    expect(getPagination({ page: '0', limit: '500' })).toEqual({ page: 1, limit: 100, skip: 0 });
    expect(getPagination({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(getPagination({})).toEqual({ page: 1, limit: 12, skip: 0 });
  });

  test('pagination meta reports neighbours', () => {
    expect(paginationMeta({ page: 2, limit: 10, total: 35 })).toMatchObject({
      totalPages: 4,
      hasNextPage: true,
      hasPrevPage: true,
    });
    expect(paginationMeta({ page: 4, limit: 10, total: 35 }).hasNextPage).toBe(false);
  });

  test('slugify normalises accents and punctuation', () => {
    expect(slugify('Café & Crème — 101!')).toBe('cafe-creme-101');
    expect(slugify('   ')).toBe('');
  });

  test('durationToSeconds understands m/h/d suffixes', () => {
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('7d')).toBe(604800);
    expect(durationToSeconds('3600')).toBe(3600);
    expect(durationToSeconds('bogus', 42)).toBe(42);
  });

  test('percentage, round and formatDuration', () => {
    expect(percentage(1, 3)).toBe(33.33);
    expect(percentage(5, 0)).toBe(0);
    expect(round(1.2345, 2)).toBe(1.23);
    expect(round(1.239, 2)).toBe(1.24);
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3700)).toBe('1h 1m');
  });

  test('seeded shuffle is deterministic per seed and preserves items', () => {
    const input = [1, 2, 3, 4, 5, 6];
    const a = seededShuffle(input, 'seed-a');
    const b = seededShuffle(input, 'seed-a');
    const c = seededShuffle(input, 'seed-b');

    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(input);
    expect(c).not.toEqual(a);
    expect(input).toEqual([1, 2, 3, 4, 5, 6]); // no mutation
  });
});
