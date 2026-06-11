import { describe, expect, test } from 'bun:test';
import { ArrayOperator, Operator, toPrisma, toSql, validateRule } from '../index';

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
