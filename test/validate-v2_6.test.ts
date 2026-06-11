import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator, validateRule } from '../index';

describe('validate v2.6 — date expressions', () => {
  test('accepts within { this: month }', () => {
    const r = validateRule({
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { this: 'month' },
    });
    expect(r).toEqual({ ok: true, errors: [] });
  });

  test('accepts before { ago: { days: 30 } }', () => {
    const r = validateRule({
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: 30 } },
    });
    expect(r.ok).toBe(true);
  });

  test('accepts before { last: month } (bare period, implied edge)', () => {
    const r = validateRule({
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { last: 'month' },
    });
    expect(r.ok).toBe(true);
  });

  test('rejects within with an edge point expression', () => {
    const r = validateRule({
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { start: { last: 'month' } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('invalid_date_range');
  });

  test('rejects negative relative magnitude', () => {
    const r = validateRule({
      field: 'completedAt',
      dateOperator: DateOperator.before,
      value: { ago: { days: -30 } },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('invalid_relative_magnitude');
  });

  test('rejects unknown period unit', () => {
    const r = validateRule({
      field: 'completedAt',
      dateOperator: DateOperator.within,
      value: { this: 'fortnight' },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('invalid_period_unit');
  });
});

describe('validate v2.6 — windowing', () => {
  test('accepts orderBy/take/skip on an array rule', () => {
    const r = validateRule({
      field: 'fanMissions',
      orderBy: [{ field: 'completedAt', dir: 'desc' }],
      take: 1,
      skip: 0,
      arrayOperator: ArrayOperator.all,
      condition: { field: 'completedAt', operator: Operator.equals, value: 'x' },
    });
    expect(r.ok).toBe(true);
  });

  test('rejects negative take', () => {
    const r = validateRule({
      field: 'fanMissions',
      take: -1,
      arrayOperator: ArrayOperator.all,
      condition: { field: 'x', operator: Operator.equals, value: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('invalid_window_take');
  });

  test('rejects bad orderBy direction', () => {
    const r = validateRule({
      field: 'fanMissions',
      orderBy: [{ field: 'completedAt', dir: 'sideways' }],
      arrayOperator: ArrayOperator.all,
      condition: { field: 'x', operator: Operator.equals, value: 1 },
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.code).toBe('invalid_order_by');
  });
});
