import { describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { check, toPrisma, toSql } from '../index';
import { getWhere } from './fixtures/helpers';

// The path reader reads what a caller's data holds — bracket indices, class getters, a string's
// length — and never Object.prototype; and every zoned date string reads as its instant.

const rule = (r: object): Condition => r as never;

describe('path reads', () => {
  test('a bracket index on every rail', () => {
    const r = rule({ field: 'n', operator: 'equals', path: 'ids[1]' });
    const context = { ids: [1, 2] };
    expect(check(r, { n: 2 }, { context })).toBe(true);
    expect(toSql(r, { context }).params).toEqual([2]);
    expect(getWhere(toPrisma(r, { context }))).toEqual({ n: { equals: 2 } });
  });

  test('a getter on a class instance in context', () => {
    class User {
      get userId() {
        return 'u1';
      }
    }
    const r = rule({ field: 'owner', operator: 'equals', path: 'user.userId' });
    expect(check(r, { owner: 'u1' }, { context: { user: new User() } })).toBe(true);
    expect(toSql(r, { context: { user: new User() } }).params).toEqual(['u1']);
  });

  test('a bracket index and a string length as fields', () => {
    expect(check(rule({ field: 'tags[0]', operator: 'equals', value: 'a' }), { tags: ['a'] })).toBe(
      true,
    );
    expect(
      check(rule({ field: 'name.length', operator: 'equals', value: 3 }), { name: 'abc' }),
    ).toBe(true);
  });

  test('Object.prototype names and methods never resolve', () => {
    const r = rule({ field: 'x', operator: 'equals', path: 'list.map' });
    expect(check(r, { x: null }, { context: { list: [1] } })).toBe(true);
  });
});

describe('zoned date strings read as their instant, whatever the evaluation zone', () => {
  const opts = { timeZone: 'America/New_York' };
  test.each([
    '2026-10-05 08:00:00+00',
    '2026-10-05 10:00:00+02:00',
    '2026-10-05T10:00:00+0200',
    'Mon, 05 Oct 2026 08:00:00 GMT',
    '2026-10-05T08:00:00z',
  ])('%s', (value) => {
    const field = rule({
      field: 'ts',
      operator: 'equals',
      value: '2026-10-05T08:00:00Z',
      coerceType: 'DateTime',
    });
    expect(check(field, { ts: value }, opts)).toBe(true);
    const date = rule({ field: 'ts', dateOperator: 'onOrAfter', value });
    expect(check(date, { ts: '2026-10-05T08:00:00Z' }, opts)).toBe(true);
    expect(check(date, { ts: '2026-10-05T07:59:00Z' }, opts)).not.toBe(true);
  });

  test('a zoneless string still anchors in the evaluation zone', () => {
    const field = rule({
      field: 'ts',
      operator: 'equals',
      value: '2026-10-05 04:00',
      coerceType: 'DateTime',
    });
    expect(check(field, { ts: '2026-10-05T08:00:00Z' }, opts)).toBe(true);
  });
});
