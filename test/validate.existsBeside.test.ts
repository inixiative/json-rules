import { describe, expect, test } from 'bun:test';
import { check, Operator, validateRule } from '../index';

const codes = (rule: unknown) =>
  validateRule(rule, { positive: true }).errors.map((issue) => issue.code);
const exists = (field: string) => ({ field, operator: Operator.exists });

describe('validateRule positive: what may not be there is checked with exists beside it', () => {
  const samePath = { field: 'orgId', operator: Operator.equals, path: 'ownerId' };

  test('a comparison with a path holds on null == null, so its field needs exists', () => {
    expect(check(samePath, { orgId: null, ownerId: null })).toBe(true);
    expect(codes(samePath)).toEqual(['missingExists']);
    expect(codes({ all: [exists('orgId'), samePath] })).toEqual([]);
    expect(check({ all: [exists('orgId'), samePath] }, { orgId: null, ownerId: null })).not.toBe(
      true,
    );
  });

  test('in against a path list, and a bind, need exists on the field too', () => {
    const inPath = { field: 'orgId', operator: Operator.in, path: 'orgIds' };
    expect(codes(inPath)).toEqual(['missingExists']);
    expect(codes({ all: [exists('orgIds'), inPath] })).toEqual(['missingExists']);
    expect(codes({ all: [exists('orgId'), inPath] })).toEqual([]);
    const bound = { field: 'orgId', operator: Operator.equals, bind: 'org', bindOptional: true };
    expect(codes(bound)).toEqual(['missingExists']);
    expect(codes({ all: [exists('orgId'), bound] })).toEqual([]);
  });

  test('every read across a bridge needs exists, on either side, literal or path', () => {
    expect(codes({ field: 'actor:Acting.model', operator: Operator.in, value: ['User'] })).toEqual([
      'missingExists',
    ]);
    expect(
      codes({
        all: [
          exists('actor:Acting.model'),
          { field: 'actor:Acting.model', operator: Operator.in, value: ['User'] },
        ],
      }),
    ).toEqual([]);
    const mine = { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' };
    expect(codes({ all: [exists('ownerId'), mine] })).toEqual(['missingExists']);
    expect(codes({ all: [exists('ownerId'), exists('actor:User.id'), mine] })).toEqual([]);
    expect(codes(exists('actor:User.id'))).toEqual([]);
  });

  test('exists names the leaf it guards, not the row above it', () => {
    const mine = { field: 'orgId', operator: Operator.equals, path: 'actor:User.orgId' };
    expect(codes({ all: [exists('orgId'), exists('actor:User'), mine] })).toEqual([
      'missingExists',
    ]);
  });

  test('an exists counts in an all above the comparison, never from a sibling any', () => {
    expect(
      codes({
        all: [exists('orgId'), { any: [samePath, { field: 'x', operator: 'equals', value: 1 }] }],
      }),
    ).toEqual([]);
    expect(codes({ all: [{ all: [exists('orgId')] }, samePath] })).toEqual([]);
    expect(codes({ all: [{ any: [exists('orgId'), true] }, samePath] })).toEqual(['missingExists']);
    expect(codes({ any: [exists('orgId'), samePath] })).toEqual(['missingExists']);
  });

  test('a comparison with a literal on the row itself needs nothing', () => {
    expect(codes({ field: 'status', operator: Operator.equals, value: 'active' })).toEqual([]);
  });
});
