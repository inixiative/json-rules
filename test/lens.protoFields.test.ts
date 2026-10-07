import { describe, expect, test } from 'bun:test';
import { check, toPrisma, toSql, validateRule } from '../index';
import type { FieldMap } from '../src/fieldMap/types';
import { walkFieldPath } from '../src/fieldMap/walk';
import type { Lens } from '../src/lens/types';
import { validateRuleInLens } from '../src/lens/validateRuleInLens';
import { Operator } from '../src/operator';
import { getWhere } from './fixtures/helpers';

// Field maps are plain object literals, so a bare `fields[name]` resolves every
// Object.prototype member name as a truthy "entry" nobody declared — and the policy
// gate approved rules whose leaf check() then evaluates as unconditionally true
// (lodash get returns the Object constructor). Same hole class as the bind lookup
// fixed in 2.19.3; every field-map lookup is an own-property check.
const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const lens: Lens = {
  maps: { prisma: map },
  bridges: [],
  mapName: 'prisma',
  model: 'User',
} as never;

describe('prototype-named fields never resolve', () => {
  test('the policy gate rejects them like any other undeclared field', () => {
    expect(validateRuleInLens({ field: 'email', operator: Operator.exists }, lens).ok).toBe(true);
    expect(validateRuleInLens({ field: 'secret', operator: Operator.exists }, lens).ok).toBe(false);
    for (const name of PROTO_NAMES) {
      expect(validateRuleInLens({ field: name, operator: Operator.exists }, lens).ok).toBe(false);
    }
  });

  test('the field-path walker does not resolve them', () => {
    expect(walkFieldPath('email', map, 'User').kind).toBe('direct');
    for (const name of PROTO_NAMES) expect(walkFieldPath(name, map, 'User').kind).toBe('fallback');
  });
});

describe('prototype names read as absent on every rail', () => {
  test('a context path', () => {
    const rule = { field: 'email', operator: Operator.equals, path: 'toString' } as never;
    expect(check(rule, { email: null }, { context: {} })).toBe(true);
    expect(toSql(rule, { context: {} }).sql).toBe('"email" IS NULL');
    expect(getWhere(toPrisma(rule, { context: {} }))).toEqual({ email: { equals: null } });
  });

  test('a row path and an array item field', () => {
    expect(
      check({ field: 'email', operator: Operator.equals, path: '$.constructor' } as never, {
        email: null,
      }),
    ).toBe(true);
  });

  test('validateRule refuses a prototype coerceType', () => {
    const { errors } = validateRule({
      field: 'email',
      operator: Operator.equals,
      value: 'x',
      coerceType: 'toString',
    } as never);
    expect(errors.map((e) => e.code)).toContain('invalid_coerce_type');
  });
});
