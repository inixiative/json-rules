import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// An `all` grant must be FILTER-FIRST: out-of-scope rows are dropped before the window
// (orderBy/take/skip) and before the all-check, so only in-scope rows are evaluated. A per-row
// `negate` implication (¬scope ∨ condition) is unsound under a window (the window picks rows from
// the raw array first) and under partial comparison semantics (a missing/non-ordered field makes
// `negate` not a true complement).

const map: FieldMap = {
  models: {
    Article: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        comments: { kind: 'object', type: 'Comment', isList: true },
      },
    },
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        body: { kind: 'scalar', type: 'String' },
        score: { kind: 'scalar', type: 'Int' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'Article' };
const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('applyLens — `all` grant is filter-first', () => {
  test('windowed all: a deleted top-of-window row cannot mask a failing in-scope row (no leak)', () => {
    const n = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: { Comment: { where: { field: 'deletedAt', operator: Operator.isEmpty } } },
        },
      },
    });
    // "The single highest-scoring comment must have body == 'approved'."
    const rule = {
      field: 'comments',
      arrayOperator: ArrayOperator.all,
      orderBy: [{ field: 'score', dir: 'desc' }],
      take: 1,
      condition: { field: 'body', operator: Operator.equals, value: 'approved' },
    } as unknown as Condition;
    const composed = applyLens(rule, n);
    const data = {
      comments: [
        { score: 99, body: 'spam', deletedAt: '2020-01-01' }, // deleted → dropped before the window
        { score: 50, body: 'rejected' }, // in-scope top → body != approved → rule must fail
      ],
    };
    expect(check(composed, data)).not.toBe(true);
  });

  test('ordered-comparator grant: an out-of-scope (missing-field) row is exempt, not forced through', () => {
    const n = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: {
            Comment: { where: { field: 'score', operator: Operator.greaterThan, value: 0 } },
          },
        },
      },
    });
    const rule = {
      field: 'comments',
      arrayOperator: ArrayOperator.all,
      condition: { field: 'body', operator: Operator.equals, value: 'x' },
    } as unknown as Condition;
    const composed = applyLens(rule, n);
    const data = {
      comments: [
        { body: 'y' }, // no score → out of scope → dropped
        { score: 5, body: 'x' }, // in scope, matches
      ],
    };
    expect(check(composed, data)).toBe(true);
  });
});
