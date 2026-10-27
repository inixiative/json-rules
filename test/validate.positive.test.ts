import { describe, expect, test } from 'bun:test';
import { ArrayOperator, DateOperator, Operator, validateRule } from '../index';

const positive = (rule: unknown) => validateRule(rule, { positive: true }).ok;

describe('validateRule positive: a rule that only holds on what the row carries', () => {
  test('equals, in and equals null are positive', () => {
    expect(positive({ field: 'role', operator: Operator.equals, value: 'owner' })).toBe(true);
    expect(positive({ field: 'role', operator: Operator.in, value: ['owner', 'admin'] })).toBe(
      true,
    );
    expect(positive({ field: 'role', operator: Operator.equals, value: null })).toBe(true);
  });

  test('all and any of positive rules are positive', () => {
    expect(
      positive({
        any: [
          { field: 'role', operator: Operator.equals, value: null },
          { all: [{ field: 'type', operator: Operator.in, value: ['a'] }] },
        ],
      }),
    ).toBe(true);
  });

  test('a negation, isEmpty and notExists are refused', () => {
    expect(positive({ field: 'type', operator: Operator.notIn, value: ['a'] })).toBe(false);
    expect(positive({ field: 'role', operator: Operator.isEmpty })).toBe(false);
    expect(positive({ field: 'role', operator: Operator.notExists })).toBe(false);
    expect(
      positive({
        field: 'at',
        dateOperator: DateOperator.notBetween,
        value: ['2020-01-01', '2021-01-01'],
      }),
    ).toBe(false);
  });

  test('if/then/else, array and aggregate rules are refused, wherever they sit', () => {
    const leaf = { field: 'role', operator: Operator.equals, value: 'owner' };
    expect(positive({ all: [{ if: leaf, then: leaf, else: true }] })).toBe(false);
    expect(positive({ field: 'tags', arrayOperator: ArrayOperator.any, condition: leaf })).toBe(
      false,
    );
    expect(
      positive({
        field: 'orders',
        aggregate: { mode: 'sum', field: 'n' },
        operator: Operator.equals,
        value: 0,
      }),
    ).toBe(false);
  });

  test('without the option every shape stays valid', () => {
    expect(validateRule({ field: 'role', operator: Operator.isEmpty }).ok).toBe(true);
  });
});
