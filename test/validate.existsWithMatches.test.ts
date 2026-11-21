import { describe, expect, test } from 'bun:test';
import { check, Operator, validateRule } from '../index';

const codes = (rule: unknown) =>
  validateRule(rule, { positive: true }).errors.map((issue) => issue.code);
const exists = (field: string) => ({ field, operator: Operator.exists });

describe('validateRule positive: a field matched against another read needs exists beside it', () => {
  const samePath = { field: 'orgId', operator: Operator.equals, path: 'ownerId' };

  test('a comparison with a path holds on null == null, so its field needs exists', () => {
    expect(check(samePath, { orgId: null, ownerId: null })).toBe(true);
    expect(codes(samePath)).toEqual(['matchWithoutExists']);
    expect(codes({ all: [exists('orgId'), samePath] })).toEqual([]);
    expect(check({ all: [exists('orgId'), samePath] }, { orgId: null, ownerId: null })).not.toBe(
      true,
    );
  });

  test('in against a path list, and a bind, need exists on the field too', () => {
    const inPath = { field: 'orgId', operator: Operator.in, path: 'orgIds' };
    expect(codes(inPath)).toEqual(['matchWithoutExists']);
    expect(codes({ all: [exists('orgIds'), inPath] })).toEqual(['matchWithoutExists']);
    expect(codes({ all: [exists('orgId'), inPath] })).toEqual([]);
    const bound = { field: 'orgId', operator: Operator.equals, bind: 'org', bindOptional: true };
    expect(codes(bound)).toEqual(['matchWithoutExists']);
    expect(codes({ all: [exists('orgId'), bound] })).toEqual([]);
  });

  test('a read across a bridge is a read like any other: against a literal, missing fails on its own', () => {
    const kind = { field: 'actor:Acting.model', operator: Operator.in, value: ['User'] };
    expect(codes(kind)).toEqual([]);
    expect(check(kind, {})).not.toBe(true);
    const mine = { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' };
    expect(codes(mine)).toEqual(['matchWithoutExists']);
    expect(codes({ all: [exists('ownerId'), mine] })).toEqual([]);
    expect(check({ all: [exists('ownerId'), mine] }, { ownerId: 'u1' })).not.toBe(true);
  });

  test('exists names the field it guards, not the row above it', () => {
    const mine = { field: 'org.id', operator: Operator.equals, path: 'actor:User.orgId' };
    expect(codes({ all: [exists('org'), mine] })).toEqual(['matchWithoutExists']);
    expect(codes({ all: [exists('org.id'), mine] })).toEqual([]);
  });

  test('an exists counts in an all above the comparison, never from a sibling any', () => {
    expect(
      codes({
        all: [exists('orgId'), { any: [samePath, { field: 'x', operator: 'equals', value: 1 }] }],
      }),
    ).toEqual([]);
    expect(codes({ all: [{ all: [exists('orgId')] }, samePath] })).toEqual([]);
    expect(codes({ all: [{ any: [exists('orgId'), true] }, samePath] })).toEqual([
      'matchWithoutExists',
    ]);
    expect(codes({ any: [exists('orgId'), samePath] })).toEqual(['matchWithoutExists']);
  });

  test('a comparison with a literal on the row itself needs nothing', () => {
    expect(codes({ field: 'status', operator: Operator.equals, value: 'active' })).toEqual([]);
  });

  test('the shapes the gate does not descend are refused before it, so nothing hides inside them', () => {
    const inside = { field: 'orgId', operator: Operator.equals, path: 'ownerId' };
    for (const shape of [
      { if: inside, then: true },
      { field: 'items', arrayOperator: 'any', condition: inside },
      { field: 'items', aggregate: { mode: 'count' }, operator: 'greaterThan', value: 0 },
    ])
      expect(codes(shape)).toContain('notPositive');
  });

  test('spellings that read the same value guard each other', () => {
    expect(codes({ all: [exists('$.orgId'), samePath] })).toEqual([]);
    expect(codes({ all: [exists('["orgId"]'), samePath] })).toEqual([]);
  });
});
