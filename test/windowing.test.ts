import { describe, expect, test } from 'bun:test';
import { ArrayOperator, check, DateOperator, Operator } from '../index';

const now = new Date('2026-06-11T00:00:00Z');

describe('Windowing — driving case: last fanMission > 30 days ago', () => {
  const rule = {
    field: 'fanMissions',
    orderBy: [{ field: 'completedAt', dir: 'desc' as const }],
    take: 1,
    arrayOperator: ArrayOperator.all,
    condition: {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: 30 } },
    },
  };

  test('user whose most-recent mission is older than 30 days passes', () => {
    const user = {
      fanMissions: [
        { completedAt: '2026-01-01T00:00:00Z' },
        { completedAt: '2026-04-01T00:00:00Z' }, // most recent, still > 30d ago
      ],
    };
    expect(check(rule, user, { now })).toBe(true);
  });

  test('user with a recent mission fails (most-recent is within 30 days)', () => {
    const user = {
      fanMissions: [
        { completedAt: '2026-01-01T00:00:00Z' },
        { completedAt: '2026-06-01T00:00:00Z' }, // most recent, within 30d
      ],
    };
    expect(check(rule, user, { now })).not.toBe(true);
  });
});

describe('Windowing — order/skip/take pipeline', () => {
  test('multi-key orderBy then take', () => {
    const rule = {
      field: 'items',
      orderBy: [
        { field: 'priority', dir: 'desc' as const },
        { field: 'name', dir: 'asc' as const },
      ],
      take: 1,
      arrayOperator: ArrayOperator.all,
      condition: { field: 'name', operator: Operator.equals, value: 'alpha' },
    };
    const data = {
      items: [
        { priority: 1, name: 'zeta' },
        { priority: 2, name: 'beta' },
        { priority: 2, name: 'alpha' }, // highest priority, name asc → first
      ],
    };
    expect(check(rule, data)).toBe(true);
  });

  test('skip drops elements from the front of the ordered list', () => {
    const rule = {
      field: 'items',
      orderBy: [{ field: 'n', dir: 'asc' as const }],
      skip: 1,
      take: 1,
      arrayOperator: ArrayOperator.all,
      condition: { field: 'n', operator: Operator.equals, value: 2 },
    };
    const data = { items: [{ n: 3 }, { n: 1 }, { n: 2 }] }; // ordered [1,2,3], skip 1 → [2,3], take 1 → [2]
    expect(check(rule, data)).toBe(true);
  });
});

describe('Windowing — empty-window semantics (author-driven)', () => {
  const base = {
    field: 'fanMissions',
    orderBy: [{ field: 'completedAt', dir: 'desc' as const }],
    take: 1,
    condition: {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: 30 } },
    },
  };

  test('all is vacuously true on an empty window', () => {
    const rule = { ...base, arrayOperator: ArrayOperator.all };
    expect(check(rule, { fanMissions: [] }, { now })).toBe(true);
  });

  test('atLeast:1 is false on an empty window (existence required)', () => {
    const rule = { ...base, arrayOperator: ArrayOperator.atLeast, count: 1 };
    expect(check(rule, { fanMissions: [] }, { now })).not.toBe(true);
  });
});

describe('Windowing — aggregate over a window', () => {
  test('sum of the last 2 amounts (window excludes the big oldest order)', () => {
    // Discriminating: windowed last-2 sum = 120 (<200 → true);
    // un-windowed sum = 1120 (not <200 → false). Only the window makes this pass.
    const rule = {
      field: 'orders',
      orderBy: [{ field: 'createdAt', dir: 'desc' as const }],
      take: 2,
      aggregate: { mode: 'sum' as const, field: 'amount' },
      operator: Operator.lessThan,
      value: 200,
    };
    const data = {
      orders: [
        { createdAt: '2026-01-01', amount: 1000 }, // oldest, excluded by take 2
        { createdAt: '2026-05-01', amount: 60 },
        { createdAt: '2026-06-01', amount: 60 }, // last two sum = 120
      ],
    };
    expect(check(rule, data)).toBe(true);
  });
});
