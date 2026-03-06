import { describe, it, expect } from 'bun:test';
import { toPrisma, executePrismaQueryPlan, Operator, ArrayOperator, DateOperator } from '../index';
import type { FieldMap, ToPrismaResult, GroupByStep, WhereStep } from '../index';

// ─── Shared mock FieldMap ─────────────────────────────────────────────────────
const map: FieldMap = {
  User: {
    fields: {
      id:        { kind: 'scalar', type: 'String' },
      email:     { kind: 'scalar', type: 'String' },
      name:      { kind: 'scalar', type: 'String' },
      role:      { kind: 'enum',   type: 'UserRole' },
      metadata:  { kind: 'scalar', type: 'Json' },
      createdAt: { kind: 'scalar', type: 'DateTime' },
      posts:     { kind: 'object', type: 'Post',    isList: true,  fromFields: [],           toFields: [] },
      profile:   { kind: 'object', type: 'Profile', isList: false, fromFields: [],           toFields: [] },
    },
  },
  Post: {
    fields: {
      id:        { kind: 'scalar', type: 'String' },
      title:     { kind: 'scalar', type: 'String' },
      published: { kind: 'scalar', type: 'Boolean' },
      authorId:  { kind: 'scalar', type: 'String' },
      author:    { kind: 'object', type: 'User',   isList: false, fromFields: ['authorId'], toFields: ['id'] },
      settings:  { kind: 'scalar', type: 'Json' },
    },
  },
  Profile: {
    fields: {
      id:     { kind: 'scalar', type: 'String' },
      userId: { kind: 'scalar', type: 'String' },
      bio:    { kind: 'scalar', type: 'String' },
      user:   { kind: 'object', type: 'User', isList: false, fromFields: ['userId'], toFields: ['id'] },
    },
  },
};

// ─── Helper: extract the final WhereStep's where ─────────────────────────────
const where = (result: ToPrismaResult) => {
  const last = result.steps[result.steps.length - 1] as WhereStep;
  return last.where;
};

// ─── Result shape ─────────────────────────────────────────────────────────────
describe('toPrisma result shape', () => {
  it('always returns steps array', () => {
    const result = toPrisma({ field: 'status', operator: Operator.equals, value: 'active' });
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps.length).toBeGreaterThan(0);
  });

  it('last step is always a WhereStep', () => {
    const result = toPrisma({ field: 'status', operator: Operator.equals, value: 'active' });
    const last = result.steps[result.steps.length - 1];
    expect(last.operation).toBe('where');
  });

  it('simple result has exactly one step (the WhereStep)', () => {
    const result = toPrisma({ field: 'status', operator: Operator.equals, value: 'active' });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].operation).toBe('where');
  });
});

// ─── Scalar operators ─────────────────────────────────────────────────────────
describe('toPrisma scalar operators', () => {
  it('equals', () => {
    expect(where(toPrisma({ field: 'status', operator: Operator.equals, value: 'active' })))
      .toEqual({ status: { equals: 'active' } });
  });

  it('equals null', () => {
    expect(where(toPrisma({ field: 'deletedAt', operator: Operator.equals, value: null })))
      .toEqual({ deletedAt: { equals: null } });
  });

  it('notEquals', () => {
    expect(where(toPrisma({ field: 'role', operator: Operator.notEquals, value: 'guest' })))
      .toEqual({ role: { not: 'guest' } });
  });

  it('lessThan', () => {
    expect(where(toPrisma({ field: 'age', operator: Operator.lessThan, value: 18 })))
      .toEqual({ age: { lt: 18 } });
  });

  it('lessThanEquals', () => {
    expect(where(toPrisma({ field: 'price', operator: Operator.lessThanEquals, value: 100 })))
      .toEqual({ price: { lte: 100 } });
  });

  it('greaterThan', () => {
    expect(where(toPrisma({ field: 'score', operator: Operator.greaterThan, value: 50 })))
      .toEqual({ score: { gt: 50 } });
  });

  it('greaterThanEquals', () => {
    expect(where(toPrisma({ field: 'rating', operator: Operator.greaterThanEquals, value: 4.5 })))
      .toEqual({ rating: { gte: 4.5 } });
  });

  it('in', () => {
    expect(where(toPrisma({ field: 'status', operator: Operator.in, value: ['active', 'pending'] })))
      .toEqual({ status: { in: ['active', 'pending'] } });
  });

  it('notIn', () => {
    expect(where(toPrisma({ field: 'role', operator: Operator.notIn, value: ['banned'] })))
      .toEqual({ role: { notIn: ['banned'] } });
  });

  it('contains', () => {
    expect(where(toPrisma({ field: 'name', operator: Operator.contains, value: 'Alice' })))
      .toEqual({ name: { contains: 'Alice' } });
  });

  it('notContains', () => {
    expect(where(toPrisma({ field: 'email', operator: Operator.notContains, value: 'spam' })))
      .toEqual({ email: { not: { contains: 'spam' } } });
  });

  it('startsWith', () => {
    expect(where(toPrisma({ field: 'name', operator: Operator.startsWith, value: 'Admin' })))
      .toEqual({ name: { startsWith: 'Admin' } });
  });

  it('endsWith', () => {
    expect(where(toPrisma({ field: 'email', operator: Operator.endsWith, value: '@acme.com' })))
      .toEqual({ email: { endsWith: '@acme.com' } });
  });

  it('between', () => {
    expect(where(toPrisma({ field: 'age', operator: Operator.between, value: [18, 65] })))
      .toEqual({ age: { gte: 18, lte: 65 } });
  });

  it('notBetween', () => {
    expect(where(toPrisma({ field: 'score', operator: Operator.notBetween, value: [0, 10] })))
      .toEqual({ score: { NOT: { gte: 0, lte: 10 } } });
  });

  it('isEmpty', () => {
    expect(where(toPrisma({ field: 'bio', operator: Operator.isEmpty })))
      .toEqual({ bio: { in: [null, ''] } });
  });

  it('notEmpty', () => {
    expect(where(toPrisma({ field: 'name', operator: Operator.notEmpty })))
      .toEqual({ name: { notIn: [null, ''] } });
  });

  it('exists', () => {
    expect(where(toPrisma({ field: 'avatar', operator: Operator.exists })))
      .toEqual({ avatar: { not: null } });
  });

  it('notExists', () => {
    expect(where(toPrisma({ field: 'deletedAt', operator: Operator.notExists })))
      .toEqual({ deletedAt: { equals: null } });
  });

  it('dot-notation → nested relation filter (no map)', () => {
    expect(where(toPrisma({ field: 'user.email', operator: Operator.equals, value: 'x@y.com' })))
      .toEqual({ user: { email: { equals: 'x@y.com' } } });
  });
});

// ─── path ref ─────────────────────────────────────────────────────────────────
describe('toPrisma path ref', () => {
  it('context.path → resolves value from context', () => {
    const result = toPrisma(
      { field: 'userId', operator: Operator.equals, path: 'currentUser.id' },
      { context: { currentUser: { id: '123' } } },
    );
    expect(where(result)).toEqual({ userId: { equals: '123' } });
  });

  it('nested context.path', () => {
    const result = toPrisma(
      { field: 'orgId', operator: Operator.equals, path: 'session.org.id' },
      { context: { session: { org: { id: 'org-abc' } } } },
    );
    expect(where(result)).toEqual({ orgId: { equals: 'org-abc' } });
  });

  it('$.field → throws (no column-to-column in Prisma WHERE)', () => {
    expect(() =>
      toPrisma({ field: 'endDate', operator: Operator.greaterThan, path: '$.startDate' }),
    ).toThrow('column-to-column');
  });

  it('context.path without context option → throws', () => {
    expect(() =>
      toPrisma({ field: 'userId', operator: Operator.equals, path: 'currentUser.id' }),
    ).toThrow('context');
  });

  it('date rule: context.path resolves date value', () => {
    const since = new Date('2024-01-01');
    const result = toPrisma(
      { field: 'createdAt', dateOperator: DateOperator.after, path: 'filters.since' },
      { context: { filters: { since } } },
    );
    expect(where(result)).toEqual({ createdAt: { gt: since } });
  });

  it('date rule: $.field → throws', () => {
    expect(() =>
      toPrisma({ field: 'endDate', dateOperator: DateOperator.after, path: '$.startDate' }),
    ).toThrow('column-to-column');
  });
});

// ─── Map-aware field traversal ────────────────────────────────────────────────
describe('toPrisma map-aware traversal', () => {
  it('scalar field → direct filter (no JSON path)', () => {
    const result = toPrisma(
      { field: 'email', operator: Operator.equals, value: 'a@b.com' },
      { map, model: 'User' },
    );
    expect(where(result)).toEqual({ email: { equals: 'a@b.com' } });
  });

  it('json field with one sub-key → Prisma JSON path', () => {
    const result = toPrisma(
      { field: 'metadata.theme', operator: Operator.equals, value: 'dark' },
      { map, model: 'User' },
    );
    expect(where(result)).toEqual({ metadata: { path: ['theme'], equals: 'dark' } });
  });

  it('json field with nested sub-keys → Prisma JSON path array', () => {
    const result = toPrisma(
      { field: 'metadata.display.mode', operator: Operator.equals, value: 'compact' },
      { map, model: 'User' },
    );
    expect(where(result)).toEqual({ metadata: { path: ['display', 'mode'], equals: 'compact' } });
  });

  it('json field after relation traversal', () => {
    // User.posts is a back-relation to Post; Post.settings is Json
    // posts.settings.theme: posts (relation→Post) → settings (Json) → theme (JSON path key)
    // → { posts: { settings: { path: ['theme'], equals: 'dark' } } }
    const result = toPrisma(
      { field: 'posts.settings.theme', operator: Operator.equals, value: 'dark' },
      { map, model: 'User' },
    );
    expect(where(result)).toEqual({ posts: { settings: { path: ['theme'], equals: 'dark' } } });
  });

  it('relation traversal → nested relation filter (not JSON path)', () => {
    const result = toPrisma(
      { field: 'author.email', operator: Operator.equals, value: 'test@test.com' },
      { map, model: 'Post' },
    );
    expect(where(result)).toEqual({ author: { email: { equals: 'test@test.com' } } });
  });

  it('field not in map → falls back to nested filter', () => {
    const result = toPrisma(
      { field: 'unknownField.sub', operator: Operator.equals, value: 'x' },
      { map, model: 'User' },
    );
    expect(where(result)).toEqual({ unknownField: { sub: { equals: 'x' } } });
  });

  it('no map provided → nested filter (unchanged behavior)', () => {
    const result = toPrisma({ field: 'metadata.theme', operator: Operator.equals, value: 'dark' });
    expect(where(result)).toEqual({ metadata: { theme: { equals: 'dark' } } });
  });
});

// ─── Multi-step count operators ───────────────────────────────────────────────
describe('toPrisma multi-step count operators', () => {
  it('atLeast → GroupByStep + WhereStep with __step ref', () => {
    const result = toPrisma(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.atLeast,
        count: 3,
        condition: { field: 'published', operator: Operator.equals, value: true },
      },
      { map, model: 'User' },
    );

    expect(result.steps).toHaveLength(2);
    const groupBy = result.steps[0] as GroupByStep;
    expect(groupBy.operation).toBe('groupBy');
    expect(groupBy.model).toBe('Post');
    expect(groupBy.args.by).toEqual(['authorId']);
    expect(groupBy.args.where).toEqual({ published: { equals: true } });
    expect(groupBy.args.having).toEqual({ _count: { _all: { gte: 3 } } });
    expect(groupBy.extract).toBe('authorId');

    const w = result.steps[1] as WhereStep;
    expect(w.operation).toBe('where');
    expect(w.where).toEqual({ id: { in: { __step: 0 } } });
  });

  it('atMost → having lte', () => {
    const result = toPrisma(
      { field: 'posts', arrayOperator: ArrayOperator.atMost, count: 5 },
      { map, model: 'User' },
    );
    const groupBy = result.steps[0] as GroupByStep;
    expect(groupBy.args.having).toEqual({ _count: { _all: { lte: 5 } } });
  });

  it('exactly → having equals', () => {
    const result = toPrisma(
      { field: 'posts', arrayOperator: ArrayOperator.exactly, count: 2 },
      { map, model: 'User' },
    );
    const groupBy = result.steps[0] as GroupByStep;
    expect(groupBy.args.having).toEqual({ _count: { _all: { equals: 2 } } });
  });

  it('count defaults to 1 when not specified', () => {
    const result = toPrisma(
      { field: 'posts', arrayOperator: ArrayOperator.atLeast },
      { map, model: 'User' },
    );
    const groupBy = result.steps[0] as GroupByStep;
    expect(groupBy.args.having).toEqual({ _count: { _all: { gte: 1 } } });
  });

  it('atLeast without map → throws', () => {
    expect(() =>
      toPrisma({ field: 'posts', arrayOperator: ArrayOperator.atLeast, count: 2 }),
    ).toThrow();
  });

  it('atMost without map → throws', () => {
    expect(() =>
      toPrisma({ field: 'posts', arrayOperator: ArrayOperator.atMost, count: 2 }),
    ).toThrow();
  });

  it('exactly without map → throws', () => {
    expect(() =>
      toPrisma({ field: 'posts', arrayOperator: ArrayOperator.exactly, count: 1 }),
    ).toThrow();
  });

  it('multiple count conditions → sequential step refs', () => {
    const result = toPrisma(
      {
        all: [
          { field: 'posts', arrayOperator: ArrayOperator.atLeast, count: 2 },
          { field: 'posts', arrayOperator: ArrayOperator.atMost, count: 10 },
        ],
      },
      { map, model: 'User' },
    );
    // 2 groupBy steps + 1 where step
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0].operation).toBe('groupBy');
    expect(result.steps[1].operation).toBe('groupBy');
    expect(result.steps[2].operation).toBe('where');

    const w = result.steps[2] as WhereStep;
    expect(w.where).toEqual({
      AND: [
        { id: { in: { __step: 0 } } },
        { id: { in: { __step: 1 } } },
      ],
    });
  });
});

// ─── executePrismaQueryPlan ───────────────────────────────────────────────────
describe('executePrismaQueryPlan', () => {
  it('no groupBy steps → returns where directly', async () => {
    const result = toPrisma({ field: 'id', operator: Operator.equals, value: '123' });
    const resolved = await executePrismaQueryPlan(result, {});
    expect(resolved).toEqual({ id: { equals: '123' } });
  });

  it('resolves __step sentinels with groupBy results', async () => {
    const result = toPrisma(
      {
        field: 'posts',
        arrayOperator: ArrayOperator.atLeast,
        count: 1,
        condition: { field: 'published', operator: Operator.equals, value: true },
      },
      { map, model: 'User' },
    );

    const mockDelegate = {
      post: {
        groupBy: async () => [{ authorId: 'user-1' }, { authorId: 'user-2' }],
      },
    };

    const resolved = await executePrismaQueryPlan(result, mockDelegate);
    expect(resolved).toEqual({ id: { in: ['user-1', 'user-2'] } });
  });

  it('resolves nested __step sentinels', async () => {
    const plan: ToPrismaResult = {
      steps: [
        {
          operation: 'groupBy',
          model: 'Post',
          args: { by: ['authorId'], where: {}, having: {} },
          extract: 'authorId',
        },
        {
          operation: 'where',
          where: { AND: [{ id: { in: { __step: 0 } } }, { status: { equals: 'active' } }] },
        },
      ],
    };

    const mockDelegate = {
      post: { groupBy: async () => [{ authorId: 'u1' }] },
    };

    const resolved = await executePrismaQueryPlan(plan, mockDelegate);
    expect(resolved).toEqual({ AND: [{ id: { in: ['u1'] } }, { status: { equals: 'active' } }] });
  });

  it('throws when delegate missing for model', async () => {
    const result = toPrisma(
      { field: 'posts', arrayOperator: ArrayOperator.atLeast, count: 1 },
      { map, model: 'User' },
    );
    await expect(executePrismaQueryPlan(result, {})).rejects.toThrow('post');
  });

  it('throws when __step index out of range', async () => {
    const plan: ToPrismaResult = {
      steps: [{ operation: 'where', where: { id: { in: { __step: 5 } } } }],
    };
    await expect(executePrismaQueryPlan(plan, {})).rejects.toThrow('out of range');
  });
});

// ─── Date operators ───────────────────────────────────────────────────────────
describe('toPrisma date operators', () => {
  const d = new Date('2024-01-01');

  it('before', () => {
    expect(where(toPrisma({ field: 'createdAt', dateOperator: DateOperator.before, value: d })))
      .toEqual({ createdAt: { lt: d } });
  });

  it('after', () => {
    expect(where(toPrisma({ field: 'createdAt', dateOperator: DateOperator.after, value: d })))
      .toEqual({ createdAt: { gt: d } });
  });

  it('onOrBefore', () => {
    expect(where(toPrisma({ field: 'expiresAt', dateOperator: DateOperator.onOrBefore, value: d })))
      .toEqual({ expiresAt: { lte: d } });
  });

  it('onOrAfter', () => {
    expect(where(toPrisma({ field: 'startDate', dateOperator: DateOperator.onOrAfter, value: d })))
      .toEqual({ startDate: { gte: d } });
  });

  it('between', () => {
    const end = new Date('2024-12-31');
    expect(where(toPrisma({ field: 'eventDate', dateOperator: DateOperator.between, value: [d, end] })))
      .toEqual({ eventDate: { gte: d, lte: end } });
  });

  it('notBetween', () => {
    const end = new Date('2024-12-31');
    expect(where(toPrisma({ field: 'eventDate', dateOperator: DateOperator.notBetween, value: [d, end] })))
      .toEqual({ eventDate: { NOT: { gte: d, lte: end } } });
  });

  it('dayIn → throws (no Prisma equivalent)', () => {
    expect(() =>
      toPrisma({ field: 'scheduledAt', dateOperator: DateOperator.dayIn, value: ['monday'] }),
    ).toThrow();
  });
});

// ─── Logical operators ────────────────────────────────────────────────────────
describe('toPrisma logical operators', () => {
  it('all (AND)', () => {
    const result = toPrisma({
      all: [
        { field: 'status', operator: Operator.equals, value: 'active' },
        { field: 'verified', operator: Operator.equals, value: true },
      ],
    });
    expect(where(result)).toEqual({
      AND: [{ status: { equals: 'active' } }, { verified: { equals: true } }],
    });
  });

  it('empty all → {}', () => {
    expect(where(toPrisma({ all: [] }))).toEqual({});
  });

  it('any (OR)', () => {
    const result = toPrisma({
      any: [
        { field: 'role', operator: Operator.equals, value: 'admin' },
        { field: 'role', operator: Operator.equals, value: 'superadmin' },
      ],
    });
    expect(where(result)).toEqual({
      OR: [{ role: { equals: 'admin' } }, { role: { equals: 'superadmin' } }],
    });
  });

  it('if/then', () => {
    const result = toPrisma({
      if: { field: 'type', operator: Operator.equals, value: 'premium' },
      then: { field: 'credits', operator: Operator.greaterThan, value: 0 },
    });
    expect(where(result)).toEqual({
      OR: [
        { NOT: { type: { equals: 'premium' } } },
        { credits: { gt: 0 } },
      ],
    });
  });

  it('boolean true → empty where', () => {
    expect(where(toPrisma(true))).toEqual({});
  });

  it('boolean false → throws', () => {
    expect(() => toPrisma(false)).toThrow();
  });
});

// ─── Array operators (Prisma-native) ─────────────────────────────────────────
describe('toPrisma array operators', () => {
  it('all → every', () => {
    const result = toPrisma({
      field: 'posts',
      arrayOperator: ArrayOperator.all,
      condition: { field: 'published', operator: Operator.equals, value: true },
    });
    expect(where(result)).toEqual({ posts: { every: { published: { equals: true } } } });
  });

  it('any → some', () => {
    const result = toPrisma({
      field: 'comments',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'approved', operator: Operator.equals, value: true },
    });
    expect(where(result)).toEqual({ comments: { some: { approved: { equals: true } } } });
  });

  it('none → none', () => {
    const result = toPrisma({
      field: 'reports',
      arrayOperator: ArrayOperator.none,
      condition: { field: 'resolved', operator: Operator.equals, value: false },
    });
    expect(where(result)).toEqual({ reports: { none: { resolved: { equals: false } } } });
  });

  it('empty → none: {}', () => {
    expect(where(toPrisma({ field: 'tags', arrayOperator: ArrayOperator.empty })))
      .toEqual({ tags: { none: {} } });
  });

  it('notEmpty → some: {}', () => {
    expect(where(toPrisma({ field: 'tags', arrayOperator: ArrayOperator.notEmpty })))
      .toEqual({ tags: { some: {} } });
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────
describe('toPrisma error cases', () => {
  it('matches → throws (no Prisma equivalent)', () => {
    expect(() =>
      toPrisma({ field: 'phone', operator: Operator.matches, value: '^\\+1' }),
    ).toThrow('matches');
  });

  it('notMatches → throws', () => {
    expect(() =>
      toPrisma({ field: 'code', operator: Operator.notMatches, value: 'test' }),
    ).toThrow('notMatches');
  });

  it('between without array → throws', () => {
    expect(() =>
      toPrisma({ field: 'age', operator: Operator.between, value: 18 }),
    ).toThrow('array');
  });
});
