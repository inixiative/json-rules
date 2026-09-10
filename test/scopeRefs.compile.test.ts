import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator, toPrisma, toSql } from '../index';

const inOrders = (condition: unknown) => ({
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition,
});

describe('toSql — scope refs are check-only beyond the same row', () => {
  test('$. path stays a column-to-column comparison', () => {
    const { sql } = toSql({
      field: 'endDate',
      operator: Operator.greaterThan,
      path: '$.startDate',
    });
    expect(sql).toBe('"endDate" > "startDate"');
  });

  test('$$. path throws naming check()', () => {
    expect(() =>
      toSql({ field: 'a', operator: Operator.equals, path: '$$.b' }, { context: {} }),
    ).toThrow(/'\$\$\.b'.*check\(\)/);
  });

  test('prefixed field throws on a field rule', () => {
    expect(() => toSql({ field: '$.a', operator: Operator.equals, value: 1 })).toThrow(
      /'\$\.a'.*check\(\)/,
    );
  });

  test('prefixed field throws on a date rule', () => {
    expect(() =>
      toSql({ field: '$.shippedAt', dateOperator: DateOperator.before, value: '2026-01-01' }),
    ).toThrow(/'\$\.shippedAt'.*check\(\)/);
  });

  test('prefixed field throws on aggregate and array rules', () => {
    expect(() =>
      toSql({
        field: '$.scores',
        aggregate: { mode: 'sum' },
        operator: Operator.greaterThan,
        value: 1,
      }),
    ).toThrow(/'\$\.scores'.*check\(\)/);
    expect(() => toSql({ field: '$.tags', arrayOperator: ArrayOperator.notEmpty })).toThrow(
      /'\$\.tags'.*check\(\)/,
    );
  });
});

describe('toPrisma — any scope ref is check-only', () => {
  test('$$. path inside a relation filter throws', () => {
    expect(() =>
      toPrisma(inOrders({ field: 'total', operator: Operator.lessThan, path: '$$.cap' }) as never),
    ).toThrow(/'\$\$\.cap'.*check\(\)/);
  });

  test('prefixed field throws on a field rule', () => {
    expect(() => toPrisma({ field: '$.a', operator: Operator.equals, value: 1 })).toThrow(
      /'\$\.a'.*check\(\)/,
    );
  });

  test('prefixed field throws on a date rule', () => {
    expect(() =>
      toPrisma({ field: '$$.shippedAt', dateOperator: DateOperator.before, value: '2026-01-01' }),
    ).toThrow(/'\$\$\.shippedAt'.*check\(\)/);
  });

  test('prefixed field throws on aggregate and array rules', () => {
    expect(() =>
      toPrisma({
        field: '$.orders',
        aggregate: { mode: 'sum', field: 'total' },
        operator: Operator.greaterThan,
        value: 1,
      }),
    ).toThrow(/'\$\.orders'.*check\(\)/);
    expect(() => toPrisma({ field: '$.tags', arrayOperator: ArrayOperator.notEmpty })).toThrow(
      /'\$\.tags'.*check\(\)/,
    );
  });
});
