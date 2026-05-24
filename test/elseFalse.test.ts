import { describe, expect, it } from 'bun:test';
import { check } from '../src/check';
import { Operator } from '../src/operator';
import { toPrisma } from '../src/toPrisma';
import { toSql } from '../src/toSql';
import { getWhere } from './fixtures/helpers';

// `false` is a legal Condition value (deny branch). `if/then/else: false` should
// evaluate else to false, not be silently skipped via truthiness check.
//
// Semantic intent: "if X, then Y, else fail" — common in AI-authored rules where
// the else acts as an explicit-deny gate.

describe('check: `else: false` is a deny branch', () => {
  it('if false, else false → returns false (was: true via truthiness skip)', () => {
    const rule = {
      if: { field: 'tier', operator: Operator.equals, value: 'gold' },
      then: { field: 'email', operator: Operator.contains, value: '@' },
      else: false as const,
    };
    // tier=silver → if=false → take else branch which is `false` → rule fails
    const result = check(rule, { tier: 'silver', email: 'x@y.com' });
    expect(result).not.toBe(true);
  });

  it('if true, then taken (else unreached, regardless of else value)', () => {
    const rule = {
      if: { field: 'tier', operator: Operator.equals, value: 'gold' },
      then: { field: 'email', operator: Operator.contains, value: '@' },
      else: false as const,
    };
    expect(check(rule, { tier: 'gold', email: 'x@y.com' })).toBe(true);
  });
});

describe('toPrisma: `else: false` emits the else branch', () => {
  it('else: false produces a clause that requires `if` to be true', () => {
    // Without the fix: cond.else truthiness check skips the else handling entirely,
    // making the rule equivalent to `if → then` only. With the fix, the else=false
    // branch participates and Prisma sees something that requires `if` to hold.
    const result = toPrisma({
      if: { field: 'tier', operator: Operator.equals, value: 'gold' },
      then: { field: 'email', operator: Operator.contains, value: '@' },
      else: false,
    });
    // The compiled output should NOT collapse to just OR[NOT(if), then].
    // It should AND that with something representing the else=false branch.
    // We test via shape: must contain top-level AND with two arms.
    const where = getWhere(result);
    expect(Object.keys(where)).toContain('AND');
  });
});

describe('toSql: `else: false` emits FALSE for the else branch', () => {
  it('else: false produces the with-else form (AND of two ORs), not the no-else form', () => {
    const result = toSql({
      if: { field: 'tier', operator: Operator.equals, value: 'gold' },
      then: { field: 'email', operator: Operator.contains, value: '@' },
      else: false,
    });
    // With the bug, this would emit `(NOT(if) OR then)` (no-else form).
    // With the fix, this emits `((NOT(if) OR then) AND (if OR FALSE))` which simplifies
    // semantically to "if AND then" — exactly what the deny-else means.
    expect(result.sql).toContain('AND');
    expect(result.sql).toContain('FALSE');
  });
});
