import { describe, expect, test } from 'bun:test';
import type { DateExpr } from '../index';
import { check, DateOperator } from '../index';

// Fixed anchor so relative expressions are deterministic.
const now = new Date('2026-06-11T00:00:00Z');

describe('Date expressions — rolling point (ago/ahead)', () => {
  test('before { ago }: field older than (now - 30d) passes; newer fails', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: 30 } },
      error: 'too recent',
    };

    // 2026-05-01 is ~41 days before now → before (now-30d=2026-05-12) → pass
    expect(check(rule, { completedAt: '2026-05-01T00:00:00Z' }, { now })).toBe(true);
    // 2026-06-01 is ~10 days before now → after (now-30d) → fail
    expect(check(rule, { completedAt: '2026-06-01T00:00:00Z' }, { now })).toBe('too recent');
  });

  test('after { ahead }: field later than (now + 7d) passes; earlier fails', () => {
    const rule = {
      field: 'dueAt',
      dateOperator: DateOperator.after,
      value: { ahead: { days: 7 } },
    };

    // now+7d = 2026-06-18; 2026-06-20 is after → pass
    expect(check(rule, { dueAt: '2026-06-20T00:00:00Z' }, { now })).toBe(true);
    // 2026-06-15 is before now+7d → fail
    expect(check(rule, { dueAt: '2026-06-15T00:00:00Z' }, { now })).not.toBe(true);
  });
});

describe('Date expressions — within (range)', () => {
  test('within { this: month }: inside the current calendar month passes', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { this: 'month' as const },
    };

    // now is 2026-06-11 → June
    expect(check(rule, { completedAt: '2026-06-01T00:00:00Z' }, { now, timeZone: 'UTC' })).toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-06-30T23:00:00Z' }, { now, timeZone: 'UTC' })).toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-05-31T23:00:00Z' }, { now, timeZone: 'UTC' })).not.toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-07-01T00:00:00Z' }, { now, timeZone: 'UTC' })).not.toBe(
      true,
    );
  });

  test('within { last: month }: inside the previous calendar month passes', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { last: 'month' as const },
    };

    // last month = May 2026
    expect(check(rule, { completedAt: '2026-05-15T00:00:00Z' }, { now, timeZone: 'UTC' })).toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-06-01T00:00:00Z' }, { now, timeZone: 'UTC' })).not.toBe(
      true,
    );
  });

  test('within { ago: days }: inside the rolling window [now-30d, now] passes', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { ago: { days: 30 } },
    };

    expect(check(rule, { completedAt: '2026-06-01T00:00:00Z' }, { now })).toBe(true); // 10d ago
    expect(check(rule, { completedAt: '2026-05-01T00:00:00Z' }, { now })).not.toBe(true); // 41d ago
  });
});

describe('Date expressions — implied & explicit period edges', () => {
  test('before { last: month } uses the START of last month (implied edge)', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { last: 'month' as const },
    };
    // last month = May; start = 2026-05-01
    expect(check(rule, { completedAt: '2026-04-15T00:00:00Z' }, { now, timeZone: 'UTC' })).toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-05-15T00:00:00Z' }, { now, timeZone: 'UTC' })).not.toBe(
      true,
    );
  });

  test('after { next: month } uses the END of next month (implied edge)', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.after,
      value: { next: 'month' as const },
    };
    // next month = July; end = 2026-07-31T23:59:59
    expect(check(rule, { completedAt: '2026-08-15T00:00:00Z' }, { now, timeZone: 'UTC' })).toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-07-15T00:00:00Z' }, { now, timeZone: 'UTC' })).not.toBe(
      true,
    );
  });

  test('before { end: { last: month } } selects the non-default edge', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { end: { last: 'month' as const } },
    };
    // end of last month (May) = 2026-05-31T23:59:59 — mid-May is before it
    expect(check(rule, { completedAt: '2026-05-15T00:00:00Z' }, { now, timeZone: 'UTC' })).toBe(
      true,
    );
    expect(check(rule, { completedAt: '2026-06-15T00:00:00Z' }, { now, timeZone: 'UTC' })).not.toBe(
      true,
    );
  });
});

describe('Date expressions — between with relative points', () => {
  test('between two ago points: inside [90d ago, 30d ago] passes', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.between,
      value: [{ ago: { days: 90 } }, { ago: { days: 30 } }] as [DateExpr, DateExpr],
    };
    expect(check(rule, { completedAt: '2026-05-01T00:00:00Z' }, { now })).toBe(true); // ~41d ago
    expect(check(rule, { completedAt: '2026-06-05T00:00:00Z' }, { now })).not.toBe(true); // ~6d ago
    expect(check(rule, { completedAt: '2026-01-01T00:00:00Z' }, { now })).not.toBe(true); // >90d ago
  });
});

describe('Date expressions — config', () => {
  test('missing `now` throws', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: 30 } },
    };
    expect(() => check(rule, { completedAt: '2026-05-01T00:00:00Z' })).toThrow(/now/);
  });

  test('weekStart governs `this: week` boundary', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { this: 'week' as const },
    };
    // now 2026-06-11 is a Thursday. Sunday 2026-06-07:
    //   - monday/isoWeek (default): week starts Mon 06-08 → excluded
    //   - sunday: week starts Sun 06-07 → included
    const sunday = { completedAt: '2026-06-07T12:00:00Z' };
    expect(check(rule, sunday, { now, timeZone: 'UTC', weekStart: 'monday' })).not.toBe(true);
    expect(check(rule, sunday, { now, timeZone: 'UTC', weekStart: 'sunday' })).toBe(true);
  });

  test('timeZone governs period boundaries', () => {
    const rule = {
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { this: 'month' as const },
    };
    // now is just past midnight UTC on June 1; in New York it is still May 31.
    const earlyJune = new Date('2026-06-01T02:00:00Z');
    const midMay = { completedAt: '2026-05-15T12:00:00Z' };
    expect(check(rule, midMay, { now: earlyJune, timeZone: 'UTC' })).not.toBe(true); // June
    expect(check(rule, midMay, { now: earlyJune, timeZone: 'America/New_York' })).toBe(true); // May
  });
});
