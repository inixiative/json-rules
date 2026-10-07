import { describe, expect, test } from 'bun:test';
import type { Condition } from '../index';
import { check, toSql, validateRule } from '../index';

// A weekday list reads any value source, and every rail reads it the same way: one name
// list, one error for an unknown name, nothing to compare against when it reads nothing.

const rule = (r: object): Condition => r as never;
const monday = { ts: '2026-10-05T12:00:00Z' };

describe('weekday lists', () => {
  test('a context path and a bind', () => {
    const fromPath = rule({ field: 'ts', dateOperator: 'dayIn', path: 'openDays' });
    expect(check(fromPath, monday, { context: { openDays: ['Monday'] } })).toBe(true);
    expect(toSql(fromPath, { context: { openDays: ['monday'] } }).params).toEqual(['UTC', [1]]);
    const bound = rule({ field: 'ts', dateOperator: 'dayNotIn', bind: 'closed' });
    expect(check(bound, monday, { bindings: { closed: ['sunday'] } })).toBe(true);
  });

  test('an unknown name throws on every rail', () => {
    const bad = rule({ field: 'ts', dateOperator: 'dayIn', value: ['funday'] });
    expect(() => check(bad, monday)).toThrow('Unknown day name: funday');
    expect(() => toSql(bad)).toThrow('Unknown day name: funday');
    expect(validateRule(bad).errors.map((e) => e.code)).toEqual(['invalid_day_list']);
  });

  test('a list that reads nothing matches nothing; a negation keeps null fields', () => {
    const none = rule({ field: 'ts', dateOperator: 'dayNotIn', path: 'closed' });
    expect(check(none, monday, { context: {} })).not.toBe(true);
    expect(check(none, { ts: null }, { context: {} })).toBe(true);
    expect(toSql(none, { context: {} }).sql).toBe('"ts" IS NULL');
  });
});
