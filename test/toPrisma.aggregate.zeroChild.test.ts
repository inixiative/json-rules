import { describe, expect, it } from 'bun:test';
import { check, executePrismaPlan, Operator, toPrisma } from '../index';
import type { FieldMap } from '../src/toPrisma/types';

// A groupBy yields no group for a parent with no (matching) children, whose sum and avg are 0
// under check(). A comparison that holds at 0 compiles as the complement of the step for its
// negation, so those parents stay in.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        posts: { kind: 'object', type: 'Post', isList: true, relationName: 'PostToUser' },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        authorId: { kind: 'scalar', type: 'String' },
        views: { kind: 'scalar', type: 'Int' },
        published: { kind: 'scalar', type: 'Boolean' },
        author: {
          kind: 'object',
          type: 'User',
          relationName: 'PostToUser',
          fromFields: ['authorId'],
          toFields: ['id'],
        },
      },
    },
  },
} as never;

const POSTS = [
  { id: 'p1', authorId: 'u1', views: 2, published: true },
  { id: 'p2', authorId: 'u1', views: 4, published: true },
  { id: 'p3', authorId: 'u2', views: 20, published: true },
  { id: 'p4', authorId: 'u4', views: 9, published: false },
];
const USERS = ['u1', 'u2', 'u3', 'u4'].map((id) => ({
  id,
  posts: POSTS.filter((p) => p.authorId === id),
}));

type Filter = Record<string, unknown>;
const holds = (n: number, f: Filter): boolean =>
  Object.entries(f).every(([op, v]) => {
    switch (op) {
      case 'gt':
        return n > (v as number);
      case 'gte':
        return n >= (v as number);
      case 'lt':
        return n < (v as number);
      case 'lte':
        return n <= (v as number);
      case 'equals':
        return n === v;
      case 'not':
        return typeof v === 'object' && v !== null ? !holds(n, v as Filter) : n !== v;
      case 'in':
        return (v as number[]).includes(n);
      case 'notIn':
        return !(v as number[]).includes(n);
      default:
        throw new Error(`fake groupBy: unsupported filter ${op}`);
    }
  });

// A minimal in-memory Prisma delegate: groupBy by authorId with a where on `published` and a
// having on `views` (_sum/_avg, optionally under NOT).
const fakePost = {
  groupBy: async (args: unknown) => {
    const { where, having } = args as { where: Filter; having: Filter };
    const published = where.published as { equals: boolean } | undefined;
    const rows = POSTS.filter((p) => !published || p.published === published.equals);
    const groups = new Map<string, number[]>();
    for (const p of rows) groups.set(p.authorId, [...(groups.get(p.authorId) ?? []), p.views]);
    const negated = 'NOT' in having;
    const views = ((negated ? having.NOT : having) as Filter).views as Filter;
    const [mode, filter] = Object.entries(views)[0] as [string, Filter];
    return [...groups.entries()]
      .filter(([, vs]) => {
        const sum = vs.reduce((a, b) => a + b, 0);
        return holds(mode === '_sum' ? sum : sum / vs.length, filter) !== negated;
      })
      .map(([authorId]) => ({ authorId }));
  },
};

const passing = async (rule: Record<string, unknown>): Promise<string[]> => {
  const plan = toPrisma(rule as never, { map, model: 'User' });
  const where = (await executePrismaPlan(plan, { post: fakePost as never })) as Filter;
  const ids = (clause: Filter) => ((clause.id as Filter).in as string[]) ?? [];
  if (where.NOT)
    return USERS.filter((u) => !ids(where.NOT as Filter).includes(u.id)).map((u) => u.id);
  return USERS.filter((u) => ids(where).includes(u.id)).map((u) => u.id);
};
const expected = (rule: Record<string, unknown>): string[] =>
  USERS.filter((u) => check(rule as never, u) === true).map((u) => u.id);

const published = { field: 'published', operator: Operator.equals, value: true };

describe('toPrisma aggregates agree with check() for parents with no children', () => {
  const cases: [string, Record<string, unknown>][] = [];
  for (const mode of ['sum', 'avg'])
    for (const condition of [undefined, published])
      for (const [operator, value] of [
        [Operator.lessThan, 5],
        [Operator.lessThanEquals, 0],
        [Operator.greaterThan, 3],
        [Operator.greaterThanEquals, 0],
        [Operator.equals, 0],
        [Operator.equals, 6],
        [Operator.notEquals, 0],
        [Operator.notEquals, 6],
        [Operator.between, [0, 6]],
        [Operator.between, [3, 30]],
        [Operator.notBetween, [0, 6]],
        [Operator.notBetween, [3, 30]],
        [Operator.in, [0, 20]],
        [Operator.notIn, [0, 20]],
      ] as const)
        cases.push([
          `${mode} ${operator} ${JSON.stringify(value)}${condition ? ' of published' : ''}`,
          {
            field: 'posts',
            aggregate: { mode, field: 'views' },
            ...(condition && { condition }),
            operator,
            value,
          },
        ]);

  for (const [name, rule] of cases)
    it(name, async () => {
      expect(await passing(rule)).toEqual(expected(rule));
    });

  it('a range with a missing end matches nothing', async () => {
    const rule = {
      field: 'posts',
      aggregate: { mode: 'sum', field: 'views' },
      operator: Operator.between,
      value: [0, null],
    };
    expect(expected(rule)).toEqual([]);
    expect(await passing(rule)).toEqual([]);
  });
});
