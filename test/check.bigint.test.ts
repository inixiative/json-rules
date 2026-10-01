import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { Operator } from '../src/operator';
import type { Condition } from '../src/types';

// Prisma returns a BigInt column as a JS bigint. check() used to fail every comparison against
// one (5n === 5 is false, and a bigint was not orderable), so an in-memory rule over Prisma rows
// never matched a BigInt column. BigInt compares as Int: a bigint becomes a number on both sides.
const row = { brandMissionID: 5n, ids: [1n, 2n], name: 'x' };
const ok = (rule: Condition, data: Record<string, unknown> = row) => check(rule, data) === true;

describe('check() — BigInt compares as Int', () => {
  test('equals / notEquals against a number, stamped or not', () => {
    expect(ok({ field: 'brandMissionID', operator: Operator.equals, value: 5 })).toBe(true);
    expect(
      ok({ field: 'brandMissionID', operator: Operator.equals, value: '5', coerceType: 'BigInt' }),
    ).toBe(true);
    expect(ok({ field: 'brandMissionID', operator: Operator.notEquals, value: 5 })).toBe(false);
    expect(ok({ field: 'brandMissionID', operator: Operator.equals, value: 6 })).toBe(false);
  });

  test('ordered comparisons and ranges', () => {
    expect(ok({ field: 'brandMissionID', operator: Operator.greaterThan, value: 3 })).toBe(true);
    expect(ok({ field: 'brandMissionID', operator: Operator.lessThanEquals, value: 5 })).toBe(true);
    expect(ok({ field: 'brandMissionID', operator: Operator.between, value: [1, 10] })).toBe(true);
    expect(ok({ field: 'brandMissionID', operator: Operator.notBetween, value: [1, 10] })).toBe(
      false,
    );
  });

  test('in / notIn', () => {
    expect(ok({ field: 'brandMissionID', operator: Operator.in, value: [4, 5] })).toBe(true);
    expect(
      ok({ field: 'brandMissionID', operator: Operator.in, value: ['5'], coerceType: 'BigInt' }),
    ).toBe(true);
    expect(ok({ field: 'brandMissionID', operator: Operator.notIn, value: [5] })).toBe(false);
  });

  test('a bigint list and a bigint binding', () => {
    expect(ok({ field: 'ids', operator: Operator.contains, value: 2 })).toBe(true);
    expect(
      check({ field: 'brandMissionID', operator: Operator.equals, bind: 'id' }, row, {
        bindings: { id: 5n as unknown as number },
      }),
    ).toBe(true);
  });

  test('a path ref to another bigint', () => {
    expect(
      ok(
        { field: 'brandMissionID', operator: Operator.equals, path: 'other' },
        { ...row, other: 5n },
      ),
    ).toBe(true);
  });
});

describe('check() — a BigInt past ±2^53 throws instead of comparing wrong', () => {
  test('a row value', () => {
    expect(() =>
      check({ field: 'id', operator: Operator.equals, value: 1 }, { id: 9007199254740993n }),
    ).toThrow('outside the safe integer range');
  });

  test('a stamped digit-string literal', () => {
    expect(() =>
      check(
        { field: 'id', operator: Operator.equals, value: '9007199254740993', coerceType: 'BigInt' },
        { id: 1n },
      ),
    ).toThrow('outside the safe integer range');
  });

  test('the edge of the range still compares', () => {
    expect(
      check(
        { field: 'id', operator: Operator.equals, value: Number.MAX_SAFE_INTEGER },
        { id: 9007199254740991n },
      ),
    ).toBe(true);
  });
});
