import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// END-TO-END verification that `where` narrowing semantics behave correctly
// per array operator. Apply lens → compose with where → run check() against
// data with a mix of in-scope and out-of-scope rows. The result must match
// what a human reading the narrowing as "filter-first scope" would expect.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        comments: { kind: 'object', type: 'Comment', isList: true },
      },
    },
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        body: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

// Narrowing: scope to non-deleted comments. Applied at Comment via defaults.
const narrowing = withParent(lens, {
  prisma: {
    models: {},
    defaults: {
      models: {
        Comment: { where: { field: 'deletedAt', operator: Operator.isEmpty } },
      },
    },
  },
});

// Data: U1 has one deleted matching, one deleted non-matching, one non-deleted matching
const dataU1 = {
  id: 'u1',
  comments: [
    { id: 'c1', body: 'has foo', deletedAt: null },
    { id: 'c2', body: 'has foo too', deletedAt: '2024-01-01' }, // deleted, also matches — should be IGNORED
    { id: 'c3', body: 'banana', deletedAt: '2024-01-01' }, // deleted, doesn't match — should be IGNORED
  ],
};

// U2: all non-deleted, one doesn't match
const dataU2 = {
  id: 'u2',
  comments: [
    { id: 'c1', body: 'has foo', deletedAt: null },
    { id: 'c2', body: 'banana', deletedAt: null }, // non-deleted, doesn't match — should COUNT
  ],
};

// U3: only deleted comments
const dataU3 = {
  id: 'u3',
  comments: [
    { id: 'c1', body: 'has foo', deletedAt: '2024-01-01' },
    { id: 'c2', body: 'has foo', deletedAt: '2024-01-01' },
  ],
};

describe('arrayOperator: any — where filters before "exists" check', () => {
  const userRule: Condition = {
    field: 'comments',
    arrayOperator: ArrayOperator.any,
    condition: { field: 'body', operator: Operator.contains, value: 'foo' },
  };

  test('U1: non-deleted matching exists → PASS', () => {
    // c1 is non-deleted and matches → passes
    expect(check(applyLens(userRule, narrowing), dataU1)).toBe(true);
  });

  test('U2: non-deleted matching exists → PASS', () => {
    expect(check(applyLens(userRule, narrowing), dataU2)).toBe(true);
  });

  test('U3: only matching is deleted (out of scope) → FAIL', () => {
    expect(check(applyLens(userRule, narrowing), dataU3)).not.toBe(true);
  });
});

describe('arrayOperator: none — where filters before "exists none" check', () => {
  const userRule: Condition = {
    field: 'comments',
    arrayOperator: ArrayOperator.none,
    condition: { field: 'body', operator: Operator.contains, value: 'spam' },
  };
  // Add a row to U1 that matches the spam predicate but is deleted
  const dataWithDeletedSpam = {
    id: 'u4',
    comments: [
      { id: 'c1', body: 'normal', deletedAt: null },
      { id: 'c2', body: 'spam talk', deletedAt: '2024-01-01' }, // deleted spam — out of scope
    ],
  };

  test('deleted spam comment is ignored → PASS (no non-deleted spam)', () => {
    expect(check(applyLens(userRule, narrowing), dataWithDeletedSpam)).toBe(true);
  });

  test('non-deleted spam comment → FAIL', () => {
    const dataWithLiveSpam = {
      id: 'u5',
      comments: [{ id: 'c1', body: 'spam talk', deletedAt: null }],
    };
    expect(check(applyLens(userRule, narrowing), dataWithLiveSpam)).not.toBe(true);
  });
});

describe('arrayOperator: all — where filters BEFORE "every" check (filter-first via implication)', () => {
  // THIS is the critical case. User rule says "every comment matches foo."
  // With filter-first semantics, this should mean "every non-deleted comment matches foo."
  // U1 has a deleted non-matching comment (c3) — should NOT cause failure.
  // U2 has a non-deleted non-matching comment (c2) — SHOULD cause failure.
  const userRule: Condition = {
    field: 'comments',
    arrayOperator: ArrayOperator.all,
    condition: { field: 'body', operator: Operator.contains, value: 'foo' },
  };

  test('U1: deleted non-matching comment is ignored → PASS (every non-deleted matches)', () => {
    // c1 (non-deleted, matches), c2 (deleted, matches — ignored), c3 (deleted, doesn't match — ignored)
    // Non-deleted set: {c1}. All match foo. → PASS
    expect(check(applyLens(userRule, narrowing), dataU1)).toBe(true);
  });

  test('U2: non-deleted non-matching exists → FAIL', () => {
    // {c1 matches, c2 doesn't}. c2 is non-deleted → fails. → FAIL
    expect(check(applyLens(userRule, narrowing), dataU2)).not.toBe(true);
  });

  test('U3: all matching but deleted → PASS vacuously (no non-deleted to check)', () => {
    // Non-deleted set: {}. all over empty is vacuously true. → PASS
    expect(check(applyLens(userRule, narrowing), dataU3)).toBe(true);
  });
});

describe('arrayOperator: atLeast — where filters before counting', () => {
  const userRule: Condition = {
    field: 'comments',
    arrayOperator: ArrayOperator.atLeast,
    count: 1,
    condition: { field: 'body', operator: Operator.contains, value: 'foo' },
  };

  test('U1: 1 non-deleted matching ≥ 1 → PASS', () => {
    expect(check(applyLens(userRule, narrowing), dataU1)).toBe(true);
  });

  test('U3: 0 non-deleted matching < 1 → FAIL', () => {
    expect(check(applyLens(userRule, narrowing), dataU3)).not.toBe(true);
  });

  test('atLeast 2: U1 has only 1 non-deleted matching → FAIL', () => {
    const rule: Condition = { ...userRule, count: 2 };
    expect(check(applyLens(rule, narrowing), dataU1)).not.toBe(true);
  });
});

describe('arrayOperator: atMost — where filters before counting', () => {
  const userRule: Condition = {
    field: 'comments',
    arrayOperator: ArrayOperator.atMost,
    count: 1,
    condition: { field: 'body', operator: Operator.contains, value: 'foo' },
  };

  test('U1: 1 non-deleted matching ≤ 1 → PASS', () => {
    expect(check(applyLens(userRule, narrowing), dataU1)).toBe(true);
  });

  test('atMost 0: U1 has 1 non-deleted matching → FAIL', () => {
    const rule: Condition = { ...userRule, count: 0 };
    expect(check(applyLens(rule, narrowing), dataU1)).not.toBe(true);
  });
});

describe('regression: where on a model the rule never visits is a no-op', () => {
  const userRule: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
  // Comment scope declared but user rule only checks User
  test('rule on User only — Comment scope ignored', () => {
    expect(check(applyLens(userRule, narrowing), dataU1)).toBe(true);
  });
});
