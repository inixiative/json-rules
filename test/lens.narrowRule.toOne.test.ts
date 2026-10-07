import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import type { FieldMap } from '../src/fieldMap/types';
import { narrowRule } from '../src/lens/narrowRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
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

describe('narrowRule — to-one relation grant injection', () => {
  test('mapDefaults.User.where is AND-ed at the relation level for author.email', () => {
    const n = withParent(lens, {
      mapDefaults: { prisma: { models: { User: { where: userWhere } } } },
    });
    const rule: Condition = { field: 'author.email', operator: Operator.equals, value: 'x' };
    const composed = narrowRule(rule, n);
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
    const composed = narrowRule(rule, n) as { all: Condition[] };
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
    expect(narrowRule(rule, lens)).toBe(rule);
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
    const composed = narrowRule(rule, n) as { condition: { all: Condition[] } };
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
    expect(() => narrowRule(rule, n)).toThrow();
  });
});

describe('narrowRule — a missing related row is not a hidden one', () => {
  const n = withParent(lens, {
    mapDefaults: { prisma: { models: { User: { where: userWhere } } } },
  });
  const articles = {
    none: { author: null },
    granted: { author: { tenantId: 't1', email: 'a@x' } },
    hidden: { author: { tenantId: 't2', email: 'b@x' } },
  };
  const holds = (rule: Condition) =>
    Object.entries(articles)
      .filter(([, row]) => check(narrowRule(rule, n), row) === true)
      .map(([name]) => name);

  test('notExists on a granted relation holds where the relation is missing', () => {
    expect(holds({ field: 'author', operator: Operator.notExists })).toEqual(['none']);
  });

  test('a negation through the hop keeps the missing row and never reads the hidden one', () => {
    expect(holds({ field: 'author.email', operator: Operator.notEquals, value: 'z' })).toEqual([
      'none',
      'granted',
    ]);
  });

  test('a positive comparison reads only the granted row', () => {
    expect(holds({ field: 'author.email', operator: Operator.contains, value: '@' })).toEqual([
      'granted',
    ]);
  });

  test('a $-scoped ref inside an array rule reads a missing relation the same way', () => {
    const rule = {
      field: 'comments',
      arrayOperator: ArrayOperator.any,
      condition: { field: '$$.author', operator: Operator.notExists },
    } as Condition;
    const narrowed = narrowRule(rule, n);
    expect(check(narrowed, { author: null, comments: [{ body: 'x' }] })).toBe(true);
    expect(check(narrowed, { author: { tenantId: 't1' }, comments: [{ body: 'x' }] })).not.toBe(
      true,
    );
    expect(check(narrowed, { author: { tenantId: 't2' }, comments: [{ body: 'x' }] })).not.toBe(
      true,
    );
  });
});
