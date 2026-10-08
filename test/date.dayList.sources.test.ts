import { describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { bindRule, check, toSql, validateRule } from '../index';

// A weekday list reads any value source, and every rail reads it the same way: one name
// list, one error for an unknown name, nothing to compare against when it reads nothing.

const rule = (r: object): Condition => r as never;
const monday = { ts: '2026-10-05T12:00:00Z' };

describe('weekday lists', () => {
  test('a bind, and a root-row path', () => {
    const bound = rule({ field: 'ts', dateOperator: 'dayIn', bind: 'openDays' });
    expect(check(bound, monday, { bindings: { openDays: ['Monday'] } })).toBe(true);
    expect(toSql(bindRule(bound, { openDays: ['monday'] })).params).toEqual(['UTC', [1]]);
    const closed = rule({ field: 'ts', dateOperator: 'dayNotIn', bind: 'closed' });
    expect(check(closed, monday, { bindings: { closed: ['sunday'] } })).toBe(true);
    // A bare path reads the root row: check() evaluates it, toSql has no form for a row's list.
    const fromRow = rule({ field: 'ts', dateOperator: 'dayIn', path: 'openDays' });
    expect(check(fromRow, { ...monday, openDays: ['Monday'] })).toBe(true);
    expect(check(fromRow, { ...monday, openDays: ['Tuesday'] })).not.toBe(true);
    expect(() => toSql(fromRow)).toThrow('has no SQL form');
  });

  test('an unknown name throws on every rail', () => {
    const bad = rule({ field: 'ts', dateOperator: 'dayIn', value: ['funday'] });
    expect(() => check(bad, monday)).toThrow('Unknown day name: funday');
    expect(() => toSql(bad)).toThrow('Unknown day name: funday');
    expect(validateRule(bad).errors.map((e) => e.code)).toEqual(['invalid_day_list']);
  });

  test('a list that reads nothing matches nothing; a negation keeps null fields', () => {
    const none = rule({
      field: 'ts',
      dateOperator: 'dayNotIn',
      bind: 'closed',
      bindOptional: true,
    });
    expect(check(none, monday)).not.toBe(true);
    expect(check(none, { ts: null })).toBe(true);
    expect(toSql(none).sql).toBe('"ts" IS NULL');
    const absentRow = rule({ field: 'ts', dateOperator: 'dayNotIn', path: 'closed' });
    expect(check(absentRow, monday)).not.toBe(true);
    expect(check(absentRow, { ts: null })).toBe(true);
  });
});
