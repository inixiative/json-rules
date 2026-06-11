import { describe, expect, test } from 'bun:test';
import { DateOperator, toPrisma, toSql } from '../index';

const now = new Date('2026-06-11T00:00:00Z');
const cfg = { now, timeZone: 'UTC' };

const lastWhere = (plan: { steps: ReadonlyArray<Record<string, unknown>> }) =>
  plan.steps[plan.steps.length - 1].where;

describe('toPrisma — date expressions', () => {
  test('before { ago: days } resolves to a concrete lt bound', () => {
    const plan = toPrisma(
      { field: 'completedAt', dateOperator: DateOperator.before, value: { ago: { days: 30 } } },
      cfg,
    );
    expect(lastWhere(plan)).toEqual({
      completedAt: { lt: new Date('2026-05-12T00:00:00.000Z') },
    });
  });

  test('within { this: month } resolves to a gte/lte range', () => {
    const plan = toPrisma(
      { field: 'completedAt', dateOperator: DateOperator.within, value: { this: 'month' } },
      cfg,
    );
    expect(lastWhere(plan)).toEqual({
      completedAt: {
        gte: new Date('2026-06-01T00:00:00.000Z'),
        lte: new Date('2026-06-30T23:59:59.999Z'),
      },
    });
  });

  test('missing now throws', () => {
    expect(() =>
      toPrisma({
        field: 'completedAt',
        dateOperator: DateOperator.before,
        value: { ago: { days: 30 } },
      }),
    ).toThrow(/now/);
  });
});

describe('toSql — date expressions', () => {
  test('before { ago: days } emits a parameterized bound', () => {
    const r = toSql(
      { field: 'completedAt', dateOperator: DateOperator.before, value: { ago: { days: 30 } } },
      cfg,
    );
    expect(r.sql).toBe('"completedAt" < $1');
    expect(r.params).toEqual([new Date('2026-05-12T00:00:00.000Z')]);
  });

  test('within { this: month } emits BETWEEN with two bounds', () => {
    const r = toSql(
      { field: 'completedAt', dateOperator: DateOperator.within, value: { this: 'month' } },
      cfg,
    );
    expect(r.sql).toBe('"completedAt" BETWEEN $1 AND $2');
    expect(r.params).toEqual([
      new Date('2026-06-01T00:00:00.000Z'),
      new Date('2026-06-30T23:59:59.999Z'),
    ]);
  });
});
