import { describe, expect, test } from 'bun:test';
import { check, toSql, validateRule } from '../index';

// Patterns run on RE2, in time linear in the input: a pattern that backtracks exponentially or
// polynomially elsewhere can't stall check(). What RE2 can't run is refused on every rail.

const matches = (value: unknown) => ({ field: 'title', operator: 'matches', value }) as never;

describe('patterns run in linear time', () => {
  test.each([
    '^(a+)+$',
    '.*.*.*.*.*.*.*.*!',
    'a*a*a*a*a*a*a*a*b',
    '^(a?a?)*$',
    '(a|aa)*$',
  ])('%s', (pattern) => {
    const started = performance.now();
    expect(check(matches(pattern), { title: `${'a'.repeat(5000)}!` })).toBeDefined();
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe('what RE2 cannot run is refused on every rail', () => {
  test.each(['(a)\\1', 'a(?=b)', 'a(?<!b)'])('%s', (pattern) => {
    expect(() => check(matches(pattern), { title: 'a' })).toThrow('Refused pattern');
    expect(() => toSql(matches(pattern))).toThrow('Refused pattern');
    expect(validateRule(matches(pattern)).errors[0].code).toBe('unsupported_pattern');
  });

  test('flags other than i', () => {
    expect(() => check(matches(/a/g), { title: 'a' })).toThrow("only the 'i' flag");
  });
});

describe('case-insensitive patterns', () => {
  test('check and SQL both read the i flag', () => {
    expect(check(matches(/^AD/i), { title: 'admin' })).toBe(true);
    expect(toSql(matches(/^AD/i)).sql).toBe('"title" ~* $1');
    expect(toSql({ field: 'title', operator: 'notMatches', value: /x/i } as never).sql).toBe(
      '("title" !~* $1 OR "title" IS NULL)',
    );
  });
});
