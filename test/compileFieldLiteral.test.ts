import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '../src/fieldMap/types';
import { Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import { toSql } from '../src/toSql';
import type { Rule } from '../src/types';
import { getWhere } from './fixtures/helpers';

// How both compilers emit a field rule's literal for the column it targets. A stamped
// `coerceType` (what coerceRule and the rule builder write) coerces the literal exactly as
// check() does, so all three rails compare the same value; Decimal and BigInt keep their
// lossless string spelling; columns the map does not type are left alone.
const map: FieldMap = {
  models: {
    Event: {
      fields: {
        name: { kind: 'scalar', type: 'String' },
        count: { kind: 'scalar', type: 'Int' },
        ratio: { kind: 'scalar', type: 'Float' },
        active: { kind: 'scalar', type: 'Boolean' },
        amount: { kind: 'scalar', type: 'Decimal' },
        big: { kind: 'scalar', type: 'BigInt' },
        meta: { kind: 'scalar', type: 'Json' },
        nums: { kind: 'scalar', type: 'Int', isList: true },
        stamps: { kind: 'scalar', type: 'DateTime', isList: true },
      },
    },
  },
};
const opts = { map, model: 'Event' };
const prismaWhere = (rule: Rule) => getWhere(toPrisma(rule, opts));
const sqlParams = (rule: Rule) => toSql(rule, opts).params;

describe('a stamped literal compiles the way check() coerces it', () => {
  test('Int, Float, Boolean and String literals are coerced', () => {
    expect(
      prismaWhere({ field: 'count', operator: Operator.in, value: ['1', '2'], coerceType: 'Int' }),
    ).toEqual({ count: { in: [1, 2] } });
    expect(
      prismaWhere({
        field: 'ratio',
        operator: Operator.greaterThan,
        value: '1.5',
        coerceType: 'Float',
      }),
    ).toEqual({ ratio: { gt: 1.5 } });
    expect(
      prismaWhere({
        field: 'active',
        operator: Operator.equals,
        value: 'true',
        coerceType: 'Boolean',
      }),
    ).toEqual({ active: { equals: true } });
    expect(
      sqlParams({ field: 'name', operator: Operator.equals, value: 5, coerceType: 'String' }),
    ).toEqual(['5']);
  });

  test('Decimal strings stay strings — lossless, and Prisma takes them', () => {
    expect(
      prismaWhere({
        field: 'amount',
        operator: Operator.greaterThan,
        value: '12345678901234567890.5',
        coerceType: 'Decimal',
      }),
    ).toEqual({ amount: { gt: '12345678901234567890.5' } });
  });

  test('a stamped BigInt literal compiles as an Int', () => {
    expect(
      sqlParams({ field: 'big', operator: Operator.equals, value: '42', coerceType: 'BigInt' }),
    ).toEqual([42]);
    expect(
      prismaWhere({ field: 'big', operator: Operator.in, value: ['1', 2], coerceType: 'BigInt' }),
    ).toEqual({ big: { in: [1, 2] } });
  });

  test('an unstamped literal passes through as written', () => {
    expect(prismaWhere({ field: 'count', operator: Operator.equals, value: 3 })).toEqual({
      count: { equals: 3 },
    });
  });
});

describe('no comparison literal, no override error', () => {
  for (const operator of [
    Operator.exists,
    Operator.notExists,
    Operator.isEmpty,
    Operator.notEmpty,
  ]) {
    test(`${operator} with an overriding coerceType compiles on both rails`, () => {
      const rule = { field: 'count', operator, coerceType: 'String' } as Rule;
      expect(() => toPrisma(rule, opts)).not.toThrow();
      expect(() => toSql(rule, opts)).not.toThrow();
    });
  }

  test('equals null with an overriding coerceType compiles on both rails', () => {
    const rule: Rule = {
      field: 'count',
      operator: Operator.equals,
      value: null,
      coerceType: 'String',
    };
    expect(prismaWhere(rule)).toEqual({ count: { equals: null } });
    expect(toSql(rule, opts).sql).toBe('"t0"."count" IS NULL');
  });
});

describe('columns the map does not type are left alone', () => {
  test('a Json sub-path with a hand-written DateTime coerceType keeps its literal', () => {
    const rule: Rule = {
      field: 'meta.signup',
      operator: Operator.equals,
      value: '2024-01-01',
      coerceType: 'DateTime',
    };
    expect(prismaWhere(rule)).toEqual({ meta: { path: ['signup'], equals: '2024-01-01' } });
    expect(sqlParams(rule)).toEqual(['"2024-01-01"']);
  });

  test('stamped scalar lists keep their literals', () => {
    expect(
      prismaWhere({ field: 'nums', operator: Operator.equals, value: '3', coerceType: 'Int' }),
    ).toEqual({ nums: { equals: '3' } });
    expect(
      prismaWhere({
        field: 'stamps',
        operator: Operator.equals,
        value: '2024-01-01',
        coerceType: 'DateTime',
      }),
    ).toEqual({ stamps: { equals: '2024-01-01' } });
  });
});

describe('an epoch past the representable range', () => {
  test('throws at compile time instead of emitting an Invalid Date', () => {
    const rule: Rule = {
      field: 'createdAt',
      operator: Operator.equals,
      value: 1e20,
      coerceType: 'DateTime',
    };
    expect(() => toPrisma(rule)).toThrow("Invalid date value for DateTime field 'createdAt'");
    expect(() => toSql(rule)).toThrow("Invalid date value for DateTime field 'createdAt'");
  });
});

describe('a stamped BigInt literal past ±2^53', () => {
  test('throws at compile time instead of rounding', () => {
    const rule: Rule = {
      field: 'big',
      operator: Operator.equals,
      value: '9007199254740993',
      coerceType: 'BigInt',
    };
    expect(() => toPrisma(rule, opts)).toThrow('outside the safe integer range');
    expect(() => toSql(rule, opts)).toThrow('outside the safe integer range');
  });
});
