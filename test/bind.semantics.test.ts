import { describe, expect, test } from 'bun:test';
import { check, Operator, resolveBindings } from '../index';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';
import { getWhere } from './fixtures/helpers';

const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };

describe('bind semantics — key presence is the contract', () => {
  test('absent key throws (a forgotten binding never silently runs)', () => {
    expect(() => check(rule, { brandUuid: 'x' }, { bindings: {} })).toThrow('brandUuid');
    expect(() => check(rule, { brandUuid: 'x' })).toThrow('brandUuid');
  });

  test('present-but-null resolves to null (a value, not a missing binding)', () => {
    expect(check(rule, { brandUuid: null }, { bindings: { brandUuid: null } })).toBe(true);
    expect(check(rule, { brandUuid: 'x' }, { bindings: { brandUuid: null } })).toBe(
      'brandUuid must equal null',
    );
  });

  test('present-but-undefined normalizes to null (not a throw)', () => {
    expect(check(rule, { brandUuid: null }, { bindings: { brandUuid: undefined } })).toBe(true);
  });
});

describe('resolveBindings — normalize nullish, leave absent as tokens', () => {
  test('present undefined → value: null', () => {
    expect(resolveBindings(rule, { brandUuid: undefined })).toEqual({
      field: 'brandUuid',
      operator: Operator.equals,
      value: null,
    });
  });

  test('present null → value: null', () => {
    expect(resolveBindings(rule, { brandUuid: null })).toEqual({
      field: 'brandUuid',
      operator: Operator.equals,
      value: null,
    });
  });

  test('absent key leaves the token (partial)', () => {
    expect(resolveBindings(rule, {})).toEqual(rule);
  });
});

describe('compilers reject an unresolved bind', () => {
  const map: FieldMap = {
    models: { FanUser: { fields: { email: { kind: 'scalar', type: 'String' } } } },
  };
  const bindRule = { field: 'email', operator: Operator.equals, bind: 'x' };

  test('toPrisma throws on a surviving bind token', () => {
    expect(() =>
      toPrisma(bindRule, { map: { maps: { prisma: map } }, mapName: 'prisma', model: 'FanUser' }),
    ).toThrow(/Unresolved binding 'x'/);
  });

  test('toSql throws on a surviving bind token', () => {
    expect(() => toSql(bindRule, { map, model: 'FanUser', alias: 't0' })).toThrow(
      /Unresolved binding 'x'/,
    );
  });
});

describe('bindOptional — absence resolves to null at the seam where absence is final', () => {
  const optional = {
    field: 'region',
    operator: Operator.equals,
    bind: 'region',
    bindOptional: true,
  };
  const map: FieldMap = {
    models: { FanUser: { fields: { region: { kind: 'scalar', type: 'String' } } } },
  };

  test('check: an unsupplied optional bind compares against null instead of throwing', () => {
    expect(check(optional, { region: null }, { bindings: {} })).toBe(true);
    expect(check(optional, { region: null })).toBe(true);
    expect(check(optional, { region: 'eu' }, { bindings: {} })).toBe('region must equal null');
  });

  test('check: a supplied optional bind is an ordinary value', () => {
    expect(check(optional, { region: 'eu' }, { bindings: { region: 'eu' } })).toBe(true);
  });

  test('toPrisma compiles a surviving optional token as null', () => {
    expect(
      getWhere(
        toPrisma(optional, { map: { maps: { prisma: map } }, mapName: 'prisma', model: 'FanUser' }),
      ),
    ).toEqual({ region: { equals: null } });
  });

  test('toSql compiles a surviving optional token as null', () => {
    const out = toSql(optional, { map, model: 'FanUser', alias: 't0' });
    expect(out.sql).toMatch(/IS NULL/i);
  });

  test('a required token still throws everywhere', () => {
    expect(() => check(rule, { brandUuid: 'x' }, { bindings: {} })).toThrow('brandUuid');
    expect(() =>
      toPrisma(rule, {
        map: {
          maps: {
            prisma: {
              models: { FanUser: { fields: { brandUuid: { kind: 'scalar', type: 'String' } } } },
            },
          },
        },
        mapName: 'prisma',
        model: 'FanUser',
      }),
    ).toThrow(/Unresolved binding 'brandUuid'/);
  });
});
