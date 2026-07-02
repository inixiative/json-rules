import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

// FIX 3(c): a related-model `where` grant must be enforced on to-one / mid-path hops,
// not only when the FINAL path segment is a relation. Mirror the to-many injection.
const map: FieldMap = {
  models: {
    Article: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User' }, // to-one
        comments: { kind: 'object', type: 'Comment', isList: true }, // to-many
      },
    },
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        tenantId: { kind: 'scalar', type: 'String' },
        company: { kind: 'object', type: 'Company' }, // to-one (for mid-path)
      },
    },
    Company: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        region: { kind: 'scalar', type: 'String' },
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
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'Article' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

const userWhere: Condition = { field: 'tenantId', operator: Operator.equals, value: 't1' };

describe('applyLens — to-one relation grant injection', () => {
  test('mapDefaults.User.where is AND-ed at the relation level for author.email', () => {
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { User: { where: userWhere } } } },
    });
    const rule: Condition = { field: 'author.email', operator: Operator.equals, value: 'x' };
    const composed = applyLens(rule, n);
    // The User where is re-rooted under `author.` and AND-ed with the original rule.
    expect(composed).toEqual({
      all: [{ field: 'author.tenantId', operator: Operator.equals, value: 't1' }, rule],
    });
  });

  test('mid-path to-one hop (author.company.name) injects Company AND User grants', () => {
    const companyWhere: Condition = { field: 'region', operator: Operator.equals, value: 'us' };
    const n = withParent(lens, {
      mapDefaults: {
        prisma: { models: { User: { where: userWhere }, Company: { where: companyWhere } } },
      },
    });
    const rule: Condition = {
      field: 'author.company.name',
      operator: Operator.equals,
      value: 'Acme',
    };
    const composed = applyLens(rule, n) as { all: Condition[] };
    expect(composed.all).toContainEqual({
      field: 'author.tenantId',
      operator: Operator.equals,
      value: 't1',
    });
    expect(composed.all).toContainEqual({
      field: 'author.company.region',
      operator: Operator.equals,
      value: 'us',
    });
    expect(composed.all).toContainEqual(rule);
  });

  test('no User grant → rule returned unchanged (no spurious injection)', () => {
    const rule: Condition = { field: 'author.email', operator: Operator.equals, value: 'x' };
    expect(applyLens(rule, lens)).toBe(rule);
  });

  test('to-many injection (control) still works via the condition path', () => {
    const commentWhere: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { Comment: { where: commentWhere } } } },
    });
    const rule = {
      field: 'comments',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'body', operator: Operator.contains, value: 'foo' },
    } as Condition;
    const composed = applyLens(rule, n) as { condition: { all: Condition[] } };
    expect(composed.condition.all).toContainEqual(commentWhere);
  });

  test('SECURITY: to-one grant with a path ref fails closed (throws)', () => {
    const n = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: {
            User: { where: { field: 'tenantId', operator: Operator.equals, path: '$.id' } },
          },
        },
      },
    });
    const rule: Condition = { field: 'author.email', operator: Operator.equals, value: 'x' };
    expect(() => applyLens(rule, n)).toThrow();
  });
});
