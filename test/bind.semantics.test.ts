import { describe, expect, test } from 'bun:test';
import { check, Operator, resolveBindings } from '../index';
import { toPrisma } from '../src/toPrisma';
import type { FieldMap } from '../src/toPrisma/types';
import { toSql } from '../src/toSql';

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
