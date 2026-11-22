import { describe, expect, test } from 'bun:test';
import { ArrayOperator, check, DateOperator, Operator, validateRule } from '../index';

const positive = (rule: unknown) => validateRule(rule, { positive: true }).ok;

describe('validateRule positive: a rule that only holds on what the row carries', () => {
  test('equals and in are positive', () => {
    expect(positive({ field: 'role', operator: Operator.equals, value: 'owner' })).toBe(true);
    expect(positive({ field: 'role', operator: Operator.in, value: ['owner', 'admin'] })).toBe(
      true,
    );
  });

  test('a null check is refused: it holds on every row without a value', () => {
    expect(positive({ field: 'role', operator: Operator.equals, value: null })).toBe(false);
    expect(positive({ field: 'role', operator: Operator.in, value: ['owner', null] })).toBe(false);
    expect(
      positive({ field: 'role', operator: Operator.equals, value: { value: null } } as never),
    ).toBe(false);
    expect(positive({ field: 'role', operator: Operator.exists })).toBe(true);
  });

  test('all and any of positive rules are positive', () => {
    expect(
      positive({
        any: [
          { field: 'role', operator: Operator.equals, value: 'owner' },
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

describe('validateRule positive with rowKey: a null check beside an exists on its row key', () => {
  const codes = (rule: unknown) =>
    validateRule(rule, { positive: true, rowKey: 'id' }).errors.map((issue) => issue.code);
  const exists = (field: string) => ({ field, operator: Operator.exists });
  const isNull = (field: string) => ({ field, operator: Operator.equals, value: null });

  test('a bare null check is still refused', () => {
    expect(codes(isNull('role'))).toEqual(['nullCheckWithoutRowKey']);
    expect(codes({ field: 'role', operator: Operator.in, value: ['owner', null] })).toEqual([
      'nullCheckWithoutRowKey',
    ]);
  });

  test('the row key exists beside it: the row is there and the column is empty', () => {
    const roleless = { all: [exists('id'), isNull('role')] };
    expect(codes(roleless)).toEqual([]);
    expect(check(roleless, { id: 't1', role: null })).toBe(true);
    expect(check(roleless, { organizationId: 'o1' })).not.toBe(true);
    expect(check(roleless, { id: 't1', role: 'admin' })).not.toBe(true);
  });

  test('the key is of the row the column is read on', () => {
    const live = (key: string) => ({ all: [exists(key), isNull('org.deletedAt')] });
    expect(codes(live('id'))).toEqual(['nullCheckWithoutRowKey']);
    expect(codes(live('org.id'))).toEqual([]);
    expect(check(live('org.id'), { id: 'd1' })).not.toBe(true);
    expect(check(live('org.id'), { id: 'd1', org: null })).not.toBe(true);
    expect(check(live('org.id'), { id: 'd1', org: { id: 'o1', deletedAt: null } })).toBe(true);
    expect(codes({ all: [exists('actor:Token.id'), isNull('actor:Token.role')] })).toEqual([]);
  });

  test('another column of the row does not stand in for its key', () => {
    expect(codes({ all: [exists('organizationId'), isNull('role')] })).toEqual([
      'nullCheckWithoutRowKey',
    ]);
  });

  test('the exists counts from an all above, never from an any', () => {
    expect(codes({ all: [exists('id'), { any: [isNull('role'), isNull('source')] }] })).toEqual([]);
    expect(codes({ any: [exists('id'), isNull('role')] })).toEqual(['nullCheckWithoutRowKey']);
  });

  test('everything else the gate refuses stays refused', () => {
    const beside = (rule: unknown) => codes({ all: [exists('id'), rule] });
    expect(beside({ field: 'role', operator: Operator.notExists })).toEqual(['notPositive']);
    expect(beside({ field: 'role', operator: Operator.isEmpty })).toEqual(['notPositive']);
    expect(beside({ field: 'role', operator: Operator.notEquals, value: 'owner' })).toEqual([
      'notPositive',
    ]);
    expect(beside({ field: 'type', operator: Operator.notIn, value: ['a'] })).toEqual([
      'notPositive',
    ]);
  });
});
