import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import { validateNarrowing } from '../src/lens/narrowing';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// CRITICAL: where are anchored to the model they describe, not always to the root.
// Naive `{ all: [c, userRule] }` composition can change semantics — see the
// "deleted comments" example below.
//
// Four anchor layers:
//   1. LensNarrowing.where       — root model (existing)
//   2. defaults.models[M].where  — wherever M appears
//   3. models[M].where           — root visit of M (only meaningful when M is the root)
//   4. relations[R].where        — when descending into R (inside the rule subtree)

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

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

describe('LensNarrowing.where — root-anchored (existing behavior)', () => {
  test('ANDs into the root rule', () => {
    const userRule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };
    const scope: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
    const n: LensNarrowing = { parent: lens, maps: { prisma: { models: {} } }, where: scope };
    expect(applyLens(userRule, n)).toEqual({ all: [scope, userRule] });
  });
});

describe('defaults.models[M].where — model-anchored', () => {
  test('applies wherever the model appears in the user rule (root visit case)', () => {
    // Constraint on User. Rule operates on User at root. Constraint goes at root.
    const userRule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };
    const userConstraint: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
    const n = withParent(lens, {
      prisma: {
        models: {},
        defaults: { models: { User: { where: userConstraint } } },
      },
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentConstraint } } },
      },
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentConstraint } } },
      },
    });
    const composed = applyLens(userRule, n);
    // Should NOT have the comment constraint at root (anchored to Comment, never visited)
    expect(composed).toEqual(userRule);
  });
});

describe('relations[R].where — path-anchored', () => {
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
      prisma: {
        models: {
          User: {
            relations: {
              posts: {
                relations: {
                  comments: { where: commentConstraint },
                },
              },
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('arrayOperator: all — must use implication, not naive AND', () => {
    // User rule: every comment matches foo
    // Constraint: deletedAt isEmpty
    // Naive AND would say "every comment is non-deleted AND matches foo" — deleted rows fail.
    // Correct: "every non-deleted comment matches foo" = all(NOT(c) OR u) = all(any: [deletedAt notEmpty, u])
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { any?: Condition[]; all?: Condition[] } };
    };
    // Inner Comment condition should be an `any` (the implication form), NOT an `all`
    expect(composed.condition.condition.any).toBeDefined();
    // The first disjunct is NOT(c) which for isEmpty becomes notEmpty
    const negated = composed.condition.condition.any?.[0] as {
      field: string;
      operator: string;
    };
    expect(negated.field).toBe('deletedAt');
    expect(negated.operator).toBe(Operator.notEmpty);
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
    });
    const composed = applyLens(userRule, n) as {
      condition: { condition: { all: Condition[] } };
    };
    // The constraint anchors at the comment-arrayRule's condition level — wraps the if/then/else
    expect(composed.condition.condition.all).toContainEqual(commentScope);
  });

  test('startsWith constraint under arrayOperator: all → clear error (no inverse)', () => {
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
      prisma: {
        models: {},
        defaults: {
          models: {
            Comment: {
              // startsWith has no inverse operator in the DSL
              where: { field: 'body', operator: Operator.startsWith, value: 'admin:' },
            },
          },
        },
      },
    });
    expect(() => applyLens(userRule, n)).toThrow(/startsWith|no.*inverse|cannot.*negate/i);
  });
});

describe('models[X].where rejected at top level (2.1.1: redundant with LensNarrowing.where / defaults)', () => {
  // The top-level `models[X].where` was either redundant with LensNarrowing.where
  // (when X = root model) or dead (when X != root). 2.1.1 rejects it at validation
  // time and points the author to the right primitive. `where` inside relations[R]
  // still works (path-specific descent).
  test('validateNarrowing rejects models[rootModel].where with a helpful message', () => {
    const rootConstraint: Condition = { field: 'id', operator: Operator.equals, value: 'u1' };
    const n = withParent(lens, {
      prisma: {
        models: { User: { where: rootConstraint } },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/models\.User\.where: not allowed/);
  });

  test('validateNarrowing rejects models[nonRoot].where with a helpful message', () => {
    const commentScope: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
    const n = withParent(lens, {
      prisma: {
        models: { Comment: { where: commentScope } },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/models\.Comment\.where: not allowed/);
  });
});

describe('multiple where compose at their own anchors', () => {
  test('root-level + Comment-level both inject at correct anchors', () => {
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
      prisma: {
        models: {},
        defaults: { models: { Comment: { where: commentScope } } },
      },
      // Also a lens-level scope
    });
    n.where = rootScope;

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
