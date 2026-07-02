import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// CRITICAL: where are anchored to the model they describe, not always to the root.
// Naive `{ all: [c, userRule] }` composition can change semantics — see the
// "deleted comments" example below.
//
// Three anchor layers (2.2.0):
//   1. root.where                          — root visit of the lens anchor model
//   2. mapDefaults[X].models[M].where      — wherever M appears in map X
//   3. root.relations[R]...relations[R].where — when descending into R (rule subtree)

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
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

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('root.where — root-anchored', () => {
  test('ANDs into the root rule', () => {
    const userRule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };
    const scope: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
    const n: LensNarrowing = { parent: lens, root: { where: scope } };
    expect(applyLens(userRule, n)).toEqual({ all: [scope, userRule] });
  });
});

describe('mapDefaults[X].models[M].where — model-anchored', () => {
  test('applies wherever the model appears in the user rule (root visit case)', () => {
    // Constraint on User. Rule operates on User at root. Constraint goes at root.
    const userRule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };
    const userConstraint: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { User: { where: userConstraint } } } },
    });
    const composed = applyLens(userRule, n);
    expect(composed).toEqual({ all: [userConstraint, userRule] });
  });

  test('constraint on Comment is injected at the comment subtree, not at root (anchoring)', () => {
    // The dangerous case: constraint on Comment must travel WITH the comment traversal.
    // User rule: "find a user whose post has a comment matching 'foo'"
    // Constraint: "deletedAt is empty on Comment"
    // Correct composition: rule rewrites to include the deletedAt check INSIDE the comment subtree
    // so both predicates apply to the SAME comment.
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const commentConstraint: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentConstraint } } } },
    });
    const composed = applyLens(userRule, n) as {
      field: string;
      arrayOperator: string;
      condition: { field: string; arrayOperator: string; condition: { all: Condition[] } };
    };
    // The composed rule should preserve the outer structure, but the INNER comment condition
    // should be `{ all: [deletedAt isEmpty, body contains 'foo'] }` so they apply to the SAME comment row.
    expect(composed.field).toBe('posts');
    expect(composed.condition.field).toBe('comments');
    expect(composed.condition.condition.all).toBeDefined();
    const innerAll = composed.condition.condition.all;
    expect(innerAll).toContainEqual(commentConstraint);
    expect(innerAll).toContainEqual({
      field: 'body',
      operator: Operator.contains,
      value: 'foo',
    });
  });

  test('constraint on a model the rule never visits → no-op (constraint dropped, not at root)', () => {
    // If user rule only touches User (no comments), Comment constraint shouldn't appear at root.
    const userRule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };
    const commentConstraint: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentConstraint } } } },
    });
    const composed = applyLens(userRule, n);
    // Should NOT have the comment constraint at root (anchored to Comment, never visited)
    expect(composed).toEqual(userRule);
  });
});

describe('root.relations[R].where — path-anchored', () => {
  test('constraint on User.posts.comments injects at the comment subtree', () => {
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const commentConstraint: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
    const n = withParent(lens, {
      root: {
        relations: {
          posts: {
            relations: {
              comments: { where: commentConstraint },
            },
          },
        },
      },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    const innerAll = composed.condition.condition.all;
    expect(innerAll).toContainEqual(commentConstraint);
  });
});

describe('per-operator anchored constraint injection (Codex P1.2)', () => {
  const commentScope: Condition = { field: 'deletedAt', operator: Operator.isEmpty };

  test('arrayOperator: any — naive AND injection (exists row matching both)', () => {
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('arrayOperator: all — filter-first via the window filter, not naive AND or a per-row implication', () => {
    // User rule: every comment matches foo. Grant: only in-scope comments participate. Filter-first:
    // the grant becomes the array rule's window `filter` (check drops out-of-scope rows before
    // order/take/skip AND before the all-check), so only in-scope rows are evaluated. The inner
    // condition stays the plain user condition — no `negate` implication (unsound under a window and
    // under partial comparison semantics).
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });
    const composed = applyLens(userRule, n) as {
      condition: { filter?: Condition; condition?: Condition };
    };
    // The grant is the window filter; the inner condition is the untouched user condition.
    expect(composed.condition.filter).toEqual(commentScope);
    expect(composed.condition.condition).toEqual({
      field: 'body',
      operator: Operator.contains,
      value: 'foo',
    });
  });

  test('arrayOperator: none — naive AND injection works (no row matches both)', () => {
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.none,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    // none({all: [c, u]}) = "no row is both non-deleted AND matching" = "no non-deleted matches"
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('arrayOperator: atLeast — AND injection (count of c AND u rows)', () => {
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.atLeast,
        count: 3,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });
    const composed = applyLens(userRule, n) as unknown as {
      condition: { count: number; condition: { all: Condition[] } };
    };
    // count lives on the comments arrayRule (composed.condition), not its inner condition
    expect(composed.condition.count).toBe(3);
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('aggregate.condition — AND injection (filter rows then aggregate)', () => {
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        aggregate: { mode: 'sum' as const, field: 'id' },
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
        operator: Operator.greaterThan,
        value: 0,
      },
    } as Condition;
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('if/then/else inside a relation injects into the right anchor branches', () => {
    // The if anchored to Comment (about Comment field) — must inject into the comments-traversal
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: {
          if: { field: 'body', operator: Operator.contains, value: 'urgent' },
          then: { field: 'id', operator: Operator.exists },
          else: { field: 'id', operator: Operator.exists },
        },
      },
    } as Condition;
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    // The constraint anchors at the comment-arrayRule's condition level — wraps the if/then/else
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('startsWith constraint under arrayOperator: all → filter-injected (no inverse needed, no throw)', () => {
    // Filter-first needs no operator inverse, so a grant with a non-invertible operator (startsWith)
    // just becomes the window filter instead of throwing.
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const grant = { field: 'body', operator: Operator.startsWith, value: 'admin:' };
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: grant } } } },
    });
    const composed = applyLens(userRule, n) as { condition: { filter?: Condition } };
    expect(composed.condition.filter).toEqual(grant);
  });
});

describe('multiple where compose at their own anchors', () => {
  test('root.where + mapDefaults Comment-level both inject at correct anchors', () => {
    const userRule = {
      field: 'posts',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'comments',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'body', operator: Operator.contains, value: 'foo' },
      },
    } as Condition;
    const rootScope: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
    const commentScope: Condition = { field: 'deletedAt', operator: Operator.isEmpty };

    const n = withParent(lens, {
      root: { where: rootScope },
      mapDefaults: { prisma: { models: { Comment: { where: commentScope } } } },
    });

    const composed = applyLens(userRule, n) as {
      all: [Condition, { field: string; condition: { condition: { all: Condition[] } } }];
    };
    // Root level should have the rootScope AND the rewritten user rule
    expect(composed.all[0]).toEqual(rootScope);
    // The inner comments subtree should have the commentScope merged with the body predicate
    const innerAll = composed.all[1].condition.condition.all;
    expect(innerAll).toContainEqual(commentScope);
  });
});
