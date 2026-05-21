import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { createLens } from '../src/lens/createLens';
import { validateNarrowing } from '../src/lens/narrowing';
import type { LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Investigation: can constraints reference fields the user has been narrowed away from?
// Concern: a parent constraint on `secretField` survives even when a child narrowing omits it,
// effectively letting the constraint silently leak access logic about a hidden field.

const map: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      secretField: { kind: 'scalar', type: 'String' },
    },
  },
};

const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' });

describe('constraints — out-of-bounds investigation', () => {
  test('validateNarrowing rejects constrains referencing a field the same narrowing omits', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: { prisma: { models: { FanUser: { omits: ['secretField'] } } } },
        constrains: { field: 'secretField', operator: Operator.equals, value: 'x' },
      }),
    ).toThrow(/constrains: 'secretField'/);
  });

  test('validateNarrowing rejects constrains referencing a field ancestor picked away', () => {
    const parent: LensNarrowing = {
      parent: lens,
      maps: { prisma: { models: { FanUser: { picks: ['email'] } } } },
    };
    expect(() =>
      validateNarrowing({
        parent,
        maps: {},
        constrains: { field: 'secretField', operator: Operator.equals, value: 'x' },
      }),
    ).toThrow(/constrains: 'secretField'/);
  });

  test('ancestor constrains on a field still applies after child narrows visibility further', () => {
    // Grandparent constrains on `email`.
    // Parent picks ['email', 'id'].
    // Child picks ['email'] (more restrictive).
    // applyLens should still AND grandparent's email constraint.
    const grandparent: LensNarrowing = {
      parent: lens,
      maps: {},
      constrains: { field: 'email', operator: Operator.equals, value: 'pinned@example.com' },
    };
    const parent: LensNarrowing = {
      parent: grandparent,
      maps: { prisma: { models: { FanUser: { picks: ['email', 'id'] } } } },
    };
    const child: LensNarrowing = {
      parent,
      maps: { prisma: { models: { FanUser: { picks: ['email'] } } } },
    };

    const rule = { field: 'email', operator: Operator.equals, value: 'pinned@example.com' };
    const composed = applyLens(rule, child);
    // The grandparent constraint should be the first element of the all
    expect(composed).toEqual({
      all: [{ field: 'email', operator: Operator.equals, value: 'pinned@example.com' }, rule],
    });
  });

  test('ancestor constrains on a field a descendant narrowing OMITS is still valid (constraint references real schema field, just one the user can no longer see)', () => {
    // Grandparent constrains on `secretField` — at grandparent's level, secretField is visible
    const grandparent: LensNarrowing = {
      parent: lens,
      maps: {},
      constrains: { field: 'secretField', operator: Operator.equals, value: 'admin-only' },
    };
    // Child omits secretField — but constraint already attached upstream
    const child: LensNarrowing = {
      parent: grandparent,
      maps: { prisma: { models: { FanUser: { omits: ['secretField'] } } } },
    };
    expect(() => validateNarrowing(child)).not.toThrow();

    // applyLens preserves the grandparent constraint
    const rule = { field: 'email', operator: Operator.equals, value: 'a@b.com' };
    const composed = applyLens(rule, child);
    expect(composed).toEqual({
      all: [{ field: 'secretField', operator: Operator.equals, value: 'admin-only' }, rule],
    });

    // The composed rule, however, will FAIL checkRuleAgainstLens at child's narrowing
    // because secretField is no longer in child's projection
    const validity = checkRuleAgainstLens(composed, child);
    expect(validity.ok).toBe(false);
    expect(validity.violations.map((v) => v.path)).toContain('secretField');
  });

  test('constrains: false acts as deny-everything and still ANDs in (not dropped)', () => {
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: {},
      constrains: false,
    };
    const rule = { field: 'email', operator: Operator.equals, value: 'x' };
    expect(applyLens(rule, narrowing)).toEqual({ all: [false, rule] });
  });
});
