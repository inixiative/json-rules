import { describe, expect, it } from 'bun:test';
import { ArrayOperator, check, executePrismaQueryPlan, Operator, toPrisma } from '../index';
import type { FieldMap, GroupByStep, WhereStep } from '../src/toPrisma/types';

// atMost/exactly compiled to `id IN (groupBy having …)` — but a root with ZERO matching
// related rows produces no group, so it vanished from the IN and the plan silently
// disagreed with check(): `exactly: 0` matched nothing, ever. The zero-inclusive
// operators now compile to the COMPLEMENT of an atLeast step (NOT IN), which keeps
// group-less roots; `atLeast 0` is everyone; missing condition/count throw as check() does.

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
  { id: 'p1', authorId: 'u1', published: true },
  { id: 'p2', authorId: 'u1', published: true },
  { id: 'p3', authorId: 'u2', published: true },
  { id: 'p4', authorId: 'u4', published: false },
];
const USERS = [
  { id: 'u1', posts: POSTS.filter((p) => p.authorId === 'u1') },
  { id: 'u2', posts: POSTS.filter((p) => p.authorId === 'u2') },
  { id: 'u3', posts: [] },
  { id: 'u4', posts: POSTS.filter((p) => p.authorId === 'u4') },
];

// A minimal in-memory Prisma delegate: enough groupBy for this fixture's plans.
const fakePost = {
  groupBy: async (args: unknown) => {
    const { where, having } = args as {
      where: { published?: { equals: boolean } };
      having: { authorId: { _count: Record<string, number> } };
    };
    const surviving = POSTS.filter(
      (p) => where.published === undefined || p.published === where.published.equals,
    );
    const counts = new Map<string, number>();
    for (const p of surviving) counts.set(p.authorId, (counts.get(p.authorId) ?? 0) + 1);
    const cmp = having.authorId._count;
    return [...counts.entries()]
      .filter(([, n]) =>
        'gte' in cmp ? n >= cmp.gte : 'lte' in cmp ? n <= cmp.lte : n === cmp.equals,
      )
      .map(([authorId]) => ({ authorId }));
  },
};

const publishedCond = { field: 'published', operator: Operator.equals, value: true };

const passing = async (rule: Record<string, unknown>): Promise<string[]> => {
  const plan = toPrisma(rule as never, { map, model: 'User' });
  const where = await executePrismaQueryPlan(plan, { post: fakePost as never });
  const clause = where as { id?: { in: string[] }; NOT?: { id: { in: string[] } } };
  if (clause.NOT) return USERS.filter((u) => !clause.NOT!.id.in.includes(u.id)).map((u) => u.id);
  if (clause.id) return USERS.filter((u) => clause.id!.in.includes(u.id)).map((u) => u.id);
  return USERS.map((u) => u.id);
};

const checkPassing = (rule: Record<string, unknown>): string[] =>
  USERS.filter((u) => check(rule as never, u) === true).map((u) => u.id);

describe('count-step rails agree on zero-match roots', () => {
  it('atMost includes roots with zero matching children', async () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.atMost,
      count: 1,
      condition: publishedCond,
    };
    expect(checkPassing(rule)).toEqual(['u2', 'u3', 'u4']);
    expect(await passing(rule)).toEqual(['u2', 'u3', 'u4']);
  });

  it('exactly 0 matches exactly the roots with no matching children', async () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.exactly,
      count: 0,
      condition: publishedCond,
    };
    expect(checkPassing(rule)).toEqual(['u3', 'u4']);
    expect(await passing(rule)).toEqual(['u3', 'u4']);
  });

  it('exactly N>=1 keeps the direct IN form', async () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.exactly,
      count: 2,
      condition: publishedCond,
    };
    expect(checkPassing(rule)).toEqual(['u1']);
    expect(await passing(rule)).toEqual(['u1']);
  });

  it('atLeast N>=1 is unchanged', async () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.atLeast,
      count: 1,
      condition: publishedCond,
    };
    expect(checkPassing(rule)).toEqual(['u1', 'u2']);
    expect(await passing(rule)).toEqual(['u1', 'u2']);
  });

  it('atLeast 0 matches everyone on both rails', async () => {
    const rule = {
      field: 'posts',
      arrayOperator: ArrayOperator.atLeast,
      count: 0,
      condition: publishedCond,
    };
    expect(checkPassing(rule)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(await passing(rule)).toEqual(['u1', 'u2', 'u3', 'u4']);
  });
});

describe('count-step compiled shapes', () => {
  it('atMost compiles to NOT-IN over an atLeast count+1 step', () => {
    const plan = toPrisma(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.atMost,
        count: 2,
        condition: publishedCond,
      } as never,
      { map, model: 'User' },
    );
    const groupBy = plan.steps[0] as GroupByStep;
    expect(groupBy.args.having).toEqual({ authorId: { _count: { gte: 3 } } });
    expect((plan.steps[1] as WhereStep).where).toEqual({ NOT: { id: { in: { __step: 0 } } } });
  });

  it('mirrors check(): missing condition throws', () => {
    expect(() =>
      toPrisma({ field: 'posts', arrayOperator: ArrayOperator.atMost, count: 1 } as never, {
        map,
        model: 'User',
      }),
    ).toThrow('requires a condition');
  });

  it('mirrors check(): missing count throws', () => {
    expect(() =>
      toPrisma(
        { field: 'posts', arrayOperator: ArrayOperator.atLeast, condition: publishedCond } as never,
        {
          map,
          model: 'User',
        },
      ),
    ).toThrow('requires a count');
  });
});
