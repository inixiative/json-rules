import { describe, expect, it } from 'bun:test';
import { check } from '../src/check';
import { ArrayOperator, Operator } from '../src/operator';

// check() returns boolean | string per its public contract. An attacker-authored rule
// must never be able to crash the caller's process via an unhandled throw on bad data
// shapes — error paths should return descriptive strings.
describe('check arrayOperator on primitive arrays — return string, do not throw', () => {
  const rule = {
    field: 'tags',
    arrayOperator: ArrayOperator.all,
    condition: { field: 'x', operator: Operator.equals, value: 1 },
  };

  it('all over primitive array → returns error string, does not throw', () => {
    const result = check(rule, { tags: ['a', 'b', 'c'] });
    expect(typeof result).toBe('string');
  });

  it('any over primitive array → returns error string', () => {
    const result = check({ ...rule, arrayOperator: ArrayOperator.any }, { tags: [1, 2, 3] });
    expect(typeof result).toBe('string');
  });

  it('none over primitive array → returns error string', () => {
    const result = check({ ...rule, arrayOperator: ArrayOperator.none }, { tags: [true, false] });
    expect(typeof result).toBe('string');
  });

  it('atLeast over primitive array → returns error string', () => {
    const result = check(
      { ...rule, arrayOperator: ArrayOperator.atLeast, count: 1 },
      { tags: ['a', 'b'] },
    );
    expect(typeof result).toBe('string');
  });

  it('respects condition.error override', () => {
    const result = check({ ...rule, error: 'tags must be objects' }, { tags: ['a'] });
    expect(result).toBe('tags must be objects');
  });

  it('object array still works (regression guard)', () => {
    const result = check(rule, { tags: [{ x: 1 }, { x: 1 }] });
    expect(result).toBe(true);
  });
});
