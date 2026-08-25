import { describe, expect, test } from 'bun:test';
import { check, toPrisma } from '../index';

// 2.19.0 closed the negation half of the null divergence (compilers keep NULL rows).
// This is the other half: a DATE leaf whose column is NULL. The compilers emit a bare
// boundary that a NULL column never satisfies; check() used to throw, so the same
// stored rule crashed a per-row pass while the batch pass answered "no match".
const NOW = new Date('2026-08-25T00:00:00Z');
const opts = { now: NOW };

const DATE_RULES: Record<string, Record<string, unknown>> = {
  before: { field: 'lastLoginAt', dateOperator: 'before', value: { ago: { days: 30 } } },
  after: { field: 'lastLoginAt', dateOperator: 'after', value: { ago: { days: 30 } } },
  onOrBefore: { field: 'lastLoginAt', dateOperator: 'onOrBefore', value: '2026-01-01' },
  onOrAfter: { field: 'lastLoginAt', dateOperator: 'onOrAfter', value: '2026-01-01' },
  within: { field: 'lastLoginAt', dateOperator: 'within', value: { ago: { days: 30 } } },
  between: { field: 'lastLoginAt', dateOperator: 'between', value: ['2026-01-01', '2026-06-01'] },
  notBetween: {
    field: 'lastLoginAt',
    dateOperator: 'notBetween',
    value: ['2026-01-01', '2026-06-01'],
  },
  dayIn: { field: 'lastLoginAt', dateOperator: 'dayIn', value: ['monday'] },
  dayNotIn: { field: 'lastLoginAt', dateOperator: 'dayNotIn', value: ['monday'] },
};

describe('checkDate — a null field is a non-match, not a throw', () => {
  for (const [label, rule] of Object.entries(DATE_RULES)) {
    test(`${label} over a null column does not match and does not throw`, () => {
      expect(check(rule as never, { lastLoginAt: null }, opts)).not.toBe(true);
      expect(check(rule as never, {}, opts)).not.toBe(true);
    });
  }

  test('the rule error message is honored, like every other non-match', () => {
    expect(
      check({ ...DATE_RULES.before, error: 'dormant only' } as never, { lastLoginAt: null }, opts),
    ).toBe('dormant only');
  });

  test('epoch 0 is an instant, not absence — it compares instead of reporting no value', () => {
    expect(check(DATE_RULES.before as never, { lastLoginAt: 0 }, opts)).toBe(true);
    expect(check(DATE_RULES.after as never, { lastLoginAt: 0 }, opts)).not.toBe(true);
  });

  test("an empty string is malformed data, reported as invalid rather than as 'no value'", () => {
    expect(() => check(DATE_RULES.before as never, { lastLoginAt: '' }, opts)).toThrow(
      'is not a valid date',
    );
  });

  test('a real value still compares in both directions', () => {
    expect(check(DATE_RULES.before as never, { lastLoginAt: new Date('2026-01-01') }, opts)).toBe(
      true,
    );
    expect(
      check(DATE_RULES.before as never, { lastLoginAt: new Date('2026-08-24') }, opts),
    ).not.toBe(true);
  });
});

describe('both rails now agree on a null date column', () => {
  // The shape this came from: "members who have not logged in in 30 days" must include
  // the ones never seen at all, so the rule spells the null arm out — and both rails
  // have to read it the same way.
  const dormant = {
    any: [
      { field: 'lastLoginAt', operator: 'notExists' },
      { field: 'lastLoginAt', dateOperator: 'before', value: { ago: { days: 30 } } },
    ],
  };

  test('check() matches a never-seen member through the notExists arm', () => {
    expect(check(dormant as never, { lastLoginAt: null }, opts)).toBe(true);
  });

  test('toPrisma compiles the same rule to IS NULL OR < cutoff', () => {
    const plan = toPrisma(dormant as never, { now: NOW }) as { steps: { where: unknown }[] };
    expect(plan.steps[0]?.where).toEqual({
      OR: [
        { lastLoginAt: { equals: null } },
        { lastLoginAt: { lt: new Date('2026-07-26T00:00:00.000Z') } },
      ],
    });
  });

  test('a bare date compare answers "no match" on both rails instead of one throwing', () => {
    const bare = DATE_RULES.before;
    expect(check(bare as never, { lastLoginAt: null }, opts)).not.toBe(true);
    const plan = toPrisma(bare as never, { now: NOW }) as { steps: { where: unknown }[] };
    // No IS NULL arm — a NULL column does not satisfy a bare boundary in SQL either.
    expect(plan.steps[0]?.where).toEqual({
      lastLoginAt: { lt: new Date('2026-07-26T00:00:00.000Z') },
    });
  });
});
