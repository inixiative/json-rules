import { describe, expect, test } from 'bun:test';
import { check, toSql, validateRule } from '../index';
import { unsafePattern } from '../src/pattern';

// A repeated group whose body can match more than one way backtracks exponentially on a
// near-miss; a rule from an untrusted author must not stall the process or the database.

describe('unsafePattern', () => {
  test.each([
    '^(a+)+$',
    '(a*)*b',
    '(a|aa)*$',
    '((ab)+)+',
    '(\\d+){2,}',
    '(?:x+|y)+',
  ])('refuses %s', (pattern) => expect(unsafePattern(pattern)).not.toBeNull());
  test.each([
    '^a+$',
    '(ab)+',
    '[a+]+',
    '^\\(a+\\)+$',
    '(foo|bar)',
    '^\\d{3}-\\d{4}$',
    '(a)(b+)',
  ])('accepts %s', (pattern) => expect(unsafePattern(pattern)).toBeNull());
});

describe('every rail refuses an unsafe pattern', () => {
  const rule = { field: 'title', operator: 'matches', value: '^(a+)+$' } as never;

  test('check() throws before running it', () => {
    const started = performance.now();
    expect(() => check(rule, { title: `${'a'.repeat(40)}!` })).toThrow('Refused pattern');
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('toSql throws', () => {
    expect(() => toSql(rule)).toThrow('Refused pattern');
  });

  test('validateRule reports it', () => {
    expect(validateRule(rule).errors.map((e) => e.code)).toContain('unsafe_pattern');
  });

  test('a safe pattern still matches', () => {
    expect(
      check({ field: 'title', operator: 'matches', value: '^a+$' } as never, { title: 'aaa' }),
    ).toBe(true);
  });
});
