import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator, toPrisma, toSql, validateRule } from '../index';

const windowedArray = {
  field: 'fanMissions',
  orderBy: [{ field: 'completedAt', dir: 'desc' as const }],
  take: 1,
  arrayOperator: ArrayOperator.all,
  condition: { field: 'status', operator: Operator.equals, value: 'done' },
};

describe('Windowing — compilers reject windowed rules (no silent miscompile)', () => {
  test('toPrisma throws for a windowed rule', () => {
    expect(() => toPrisma(windowedArray)).toThrow(/window|orderBy|take|skip/i);
  });

  test('toSql throws for a windowed rule', () => {
    expect(() => toSql(windowedArray)).toThrow(/window|orderBy|take|skip/i);
  });

  test('toPrisma throws for a windowed aggregate rule', () => {
    const windowedAgg = {
      field: 'orders',
      orderBy: [{ field: 'createdAt', dir: 'desc' as const }],
      take: 2,
      aggregate: { mode: 'sum' as const, field: 'amount' },
      operator: Operator.greaterThan,
      value: 100,
    };
    expect(() => toPrisma(windowedAgg)).toThrow(/window|orderBy|take|skip/i);
  });
});

describe('Windowing — pre-window filter is check-only', () => {
  const filtered = {
    field: 'fanMissions',
    filter: { field: 'status', operator: Operator.equals, value: 'completed' },
    orderBy: [{ field: 'completedAt', dir: 'desc' as const }],
    take: 1,
    arrayOperator: ArrayOperator.all,
    condition: {
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: 30 } },
    },
  };

  test('toPrisma throws for a filtered window (extremal rewrite bails on filter)', () => {
    expect(() => toPrisma(filtered, { now: new Date('2026-06-11T00:00:00Z') })).toThrow(
      /window|filter|check/i,
    );
  });

  test('toSql throws for a filtered window', () => {
    expect(() => toSql(filtered, { now: new Date('2026-06-11T00:00:00Z') })).toThrow(
      /window|filter|check/i,
    );
  });

  test('validateRule flags a filtered window for toPrisma but allows it for check', () => {
    expect(validateRule(filtered, { target: 'toPrisma' }).ok).toBe(false);
    expect(validateRule(filtered, { target: 'check' }).ok).toBe(true);
  });
});

describe('Windowing — validator gates per target', () => {
  test('validateRule flags windowing for toPrisma', () => {
    const r = validateRule(windowedArray, { target: 'toPrisma' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'unsupported_prisma_window')).toBe(true);
  });

  test('validateRule flags windowing for toSql', () => {
    const r = validateRule(windowedArray, { target: 'toSql' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.code === 'unsupported_sql_window')).toBe(true);
  });

  test('validateRule allows windowing for check', () => {
    const r = validateRule(windowedArray, { target: 'check' });
    expect(r.ok).toBe(true);
  });
});

describe('Windowing — extremal rewrite to Prisma (take:1, aligned)', () => {
  const now = new Date('2026-06-11T00:00:00Z');
  const lastWhere = (plan: { steps: ReadonlyArray<Record<string, unknown>> }) =>
    plan.steps[plan.steps.length - 1].where;

  test('all + desc + before {ago} → every (most recent before bound)', () => {
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
    expect(lastWhere(toPrisma(rule, { now, timeZone: 'UTC' }))).toEqual({
      fanMissions: { every: { completedAt: { lt: new Date('2026-05-12T00:00:00.000Z') } } },
    });
  });

  test('any + desc + after V → some (most recent after bound)', () => {
    const rule = {
      field: 'orders',
      orderBy: [{ field: 'amount', dir: 'desc' as const }],
      take: 1,
      arrayOperator: ArrayOperator.any,
      condition: { field: 'amount', operator: Operator.greaterThan, value: 100 },
    };
    expect(lastWhere(toPrisma(rule))).toEqual({
      orders: { some: { amount: { gt: 100 } } },
    });
  });

  test('atLeast:1 maps to some', () => {
    const rule = {
      field: 'orders',
      orderBy: [{ field: 'amount', dir: 'desc' as const }],
      take: 1,
      arrayOperator: ArrayOperator.atLeast,
      count: 1,
      condition: { field: 'amount', operator: Operator.greaterThan, value: 100 },
    };
    expect(lastWhere(toPrisma(rule))).toEqual({
      orders: { some: { amount: { gt: 100 } } },
    });
  });

  test('validateRule accepts an aligned extremal rule for toPrisma', () => {
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
    expect(validateRule(rule, { target: 'toPrisma' }).ok).toBe(true);
  });

  test('misaligned (all + desc + after) still throws — max>V ≠ every>V', () => {
    const rule = {
      field: 'orders',
      orderBy: [{ field: 'amount', dir: 'desc' as const }],
      take: 1,
      arrayOperator: ArrayOperator.all,
      condition: { field: 'amount', operator: Operator.greaterThan, value: 100 },
    };
    expect(() => toPrisma(rule)).toThrow(/window|check/i);
  });

  test('take:2 is not extremal — still throws', () => {
    const rule = {
      field: 'orders',
      orderBy: [{ field: 'amount', dir: 'desc' as const }],
      take: 2,
      arrayOperator: ArrayOperator.all,
      condition: { field: 'amount', operator: Operator.lessThan, value: 100 },
    };
    expect(() => toPrisma(rule)).toThrow(/window|check/i);
  });

  test('toSql still throws for an aligned extremal rule (no relation subqueries)', () => {
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
    expect(() => toSql(rule, { now })).toThrow(/window|check/i);
  });
});
