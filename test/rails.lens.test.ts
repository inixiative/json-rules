import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  bindRule,
  type Condition,
  check,
  createLens,
  executePrismaPlan,
  type LensNarrowing,
  narrowRule,
  projectRows,
  toLensSelect,
  toPrisma,
  toSql,
  validateNarrowing,
} from '../index';
import { agree, map, openRails } from './rails/harness';

// Compiling `{ lens }` and fetching under a lens, on all three rails over one database.

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

describe('toPrisma / toSql with { lens }', () => {
  const lens: LensNarrowing = {
    parent: base,
    root: {
      where: { field: 'age', operator: 'greaterThanEquals', value: 5 },
      relations: { org: {} },
    },
    mapDefaults: {
      prisma: { models: { Org: { where: { field: 'plan', operator: 'equals', value: 'pro' } } } },
    },
  };

  test('compiles the rule narrowed by the lens, against its base: the rails agree', async () => {
    const rule: Condition = { field: 'org.seats', operator: 'lessThan', value: 100 };
    expect(await rails.run(rule)).toEqual(agree([1, 3]));
    expect(await rails.run(rule, { lens })).toEqual(agree([1]));
  });

  test("a to-one hop's clamp keeps the rows where the hop is missing for a negation", async () => {
    const rule: Condition = { field: 'org.name', operator: 'notEquals', value: 'x' };
    expect(await rails.run(rule, { lens })).toEqual(agree([1, 4, 5]));
  });

  test('is narrowRule then the base lens, exactly', () => {
    const rule: Condition = { field: 'org.name', operator: 'equals', value: 'Acme' };
    const by = { map: base, mapName: base.mapName, model: base.model };
    expect(toPrisma(rule, { lens })).toEqual(toPrisma(narrowRule(rule, lens), by));
    expect(toSql(rule, { lens })).toEqual(toSql(narrowRule(rule, lens), by));
  });

  test('a rule the lens refuses throws instead of compiling', () => {
    const hidden: LensNarrowing = { parent: base, root: { picks: ['id'] } };
    const rule: Condition = { field: 'name', operator: 'equals', value: 'Ann' };
    expect(() => toPrisma(rule, { lens: hidden })).toThrow(/leaves the lens/);
    expect(() => toSql(rule, { lens: hidden })).toThrow(/leaves the lens/);
  });

  test('a caller value is a bind: the rails agree under a lens', async () => {
    const proOrgs: LensNarrowing = {
      parent: base,
      mapDefaults: {
        prisma: { models: { Org: { where: { field: 'plan', operator: 'equals', value: 'pro' } } } },
      },
    };
    const deny: Condition = {
      if: { field: 'id', operator: 'equals', bind: 'blockedId' },
      then: false,
      else: true,
    };
    const bound = bindRule(deny, { blockedId: 2 });
    expect(await rails.run(bound, { lens: proOrgs })).toEqual(agree([1, 3, 4, 5]));
  });

  test('a bare path is a root-row column: gated, narrowed and compiled like a field', async () => {
    const shown: LensNarrowing = { parent: base, root: { relations: { org: {} } } };
    const rule: Condition = { field: 'age', operator: 'greaterThan', path: 'orgId' };
    expect(await rails.run(rule, { lens: shown })).toEqual(agree([1]));
    const hidden: LensNarrowing = { parent: base, root: { omits: ['orgId'] } };
    expect(() => toSql(rule, { lens: hidden })).toThrow(/leaves the lens/);
    const across: Condition = { field: 'age', operator: 'greaterThan', path: 'org.seats' };
    expect(() => toSql(across, { lens: base })).toThrow(/leaves the lens/);
    const viaOrg = await rails.run(across, { lens: shown });
    expect(viaOrg.check).toEqual(viaOrg.sql);
    expect(viaOrg.prisma).toMatch(/Prisma rail/);
  });

  test('a narrowing inheriting a base key from its prototype keeps its chain', () => {
    const tenant: LensNarrowing = {
      parent: base,
      root: { where: { field: 'id', operator: 'equals', value: 1 } },
    };
    const inherited = Object.assign(Object.create(base), {
      parent: tenant,
      root: { where: { field: 'id', operator: 'equals', value: 2 } },
    }) as LensNarrowing;
    const where = JSON.stringify(toPrisma(true, { lens: inherited }));
    expect(where).toContain('1');
    expect(where).toContain('2');
  });

  test('a narrowing carrying a base lens key is refused, never read as the base', () => {
    const tenant: LensNarrowing = {
      parent: base,
      root: { where: { field: 'id', operator: 'equals', value: 1 } },
    };
    const stray = { parent: tenant, model: 'User', root: {} } as unknown as LensNarrowing;
    expect(() => toPrisma(true, { lens: stray })).toThrow(/base lens key/);
  });

  test('a rule crossing a relation the lens does not turn on throws instead of compiling', () => {
    const rule: Condition = { field: 'org.parent.name', operator: 'equals', value: 'Acme' };
    expect(() => toPrisma(rule, { lens })).toThrow(/leaves the lens/);
    expect(() => toSql(rule, { lens })).toThrow(/leaves the lens/);
  });

  test('a lens with map / mapName / model is refused', () => {
    expect(() => toPrisma(true, { lens, map })).toThrow(/not both/);
    expect(() => toSql(true, { lens, model: 'User' })).toThrow(/not both/);
  });
});

describe("toLensSelect: a to-many relation's clamps as its where agree with check()", () => {
  const lens: LensNarrowing = {
    parent: base,
    root: {
      picks: ['id', 'name'],
      relations: {
        posts: {
          picks: ['id', 'title'],
          where: { field: 'views', operator: 'greaterThan', value: 5 },
        },
        org: { picks: ['id', 'name'], where: { field: 'plan', operator: 'equals', value: 'pro' } },
      },
    },
    mapDefaults: {
      prisma: {
        models: { Post: { where: { field: 'author.age', operator: 'greaterThan', value: 1 } } },
      },
    },
  };

  const fetchUnderLens = async (): Promise<Record<string, unknown>[]> =>
    (await rails.prisma.user.findMany({
      select: toLensSelect(lens).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];

  test('the selected rows, projected, are the full rows projected', async () => {
    const fetched = await fetchUnderLens();
    // Pre-narrowed: user 1 keeps only the post whose views pass the clamp.
    expect((fetched[0].posts as { id: number }[]).map((p) => p.id)).toEqual([100]);
    const options = { keepClampColumns: true };
    expect(projectRows(lens, fetched, options)).toEqual(
      projectRows(lens, rails.rows as unknown as Record<string, unknown>[], options),
    );
  });

  test('projected rows re-test the clamps: a narrowed check reads the kept columns', async () => {
    const fetched = await fetchUnderLens();
    const rows = projectRows(lens, fetched, { keepClampColumns: true });
    const rule: Condition = {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'title', operator: 'exists' },
    };
    const ids = rows.filter((row) => check(narrowRule(rule, lens), row) === true).map((r) => r.id);
    expect(ids).toEqual((await rails.run(rule, { lens })).prisma as number[]);
  });

  test.each<[string, Condition]>([
    [
      'a negation through a hidden to-one',
      { field: 'org.name', operator: 'notEquals', value: 'x' },
    ],
    ['notExists on a hidden to-one', { field: 'org', operator: 'notExists' }],
  ])('%s: the re-check fails the hidden row, as the database does', async (_, rule) => {
    const rows = projectRows(lens, await fetchUnderLens(), { keepClampColumns: true });
    const ids = rows.filter((row) => check(narrowRule(rule, lens), row) === true).map((r) => r.id);
    expect(ids).toEqual((await rails.run(rule, { lens })).prisma as number[]);
  });

  test('without keepClampColumns a hidden to-one row is null', async () => {
    const [, second] = projectRows(lens, await fetchUnderLens());
    expect(second.org).toBeNull();
  });
});

describe('fetch, project, re-check: the documented pipeline answers as the database does', () => {
  const fetchUnder = async (lens: LensNarrowing) => {
    const where = await executePrismaPlan(toPrisma(true, { lens }), rails.prisma as never);
    const rows = (await rails.prisma.user.findMany({
      where: where as never,
      select: toLensSelect(lens).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];
    return projectRows(lens, rows, { keepClampColumns: true });
  };
  const recheck = async (lens: LensNarrowing, rule: Condition) =>
    (await fetchUnder(lens))
      .filter((row) => check(narrowRule(rule, lens), row) === true)
      .map((row) => row.id);
  const database = async (lens: LensNarrowing, rule: Condition) =>
    (await rails.run(rule, { lens })).prisma as unknown[];

  test("a to-one clamp reading a narrowed list reads it whole: org 10's hidden user hides it", async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id'],
        relations: {
          org: {
            picks: ['id', 'name'],
            where: {
              field: 'users',
              arrayOperator: 'none',
              condition: { field: 'age', operator: 'greaterThan', value: 20 },
            },
            relations: {
              users: { picks: ['id'], where: { field: 'age', operator: 'lessThan', value: 20 } },
            },
          },
        },
      },
    };
    const shown = projectRows(lens, (await fetchUnder(lens)) as never);
    expect(shown.find((row) => row.id === 1)?.org).toBeNull();
    expect(await fetchUnder(lens)).toEqual(
      projectRows(lens, rails.rows as unknown as Record<string, unknown>[], {
        keepClampColumns: true,
      }),
    );
  });

  test('a root clamp reading a narrowed list keeps the row the database keeps', async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id'],
        where: {
          field: 'posts',
          arrayOperator: 'any',
          condition: { field: 'title', operator: 'equals', value: 'later' },
        },
        relations: {
          posts: { picks: ['id'], where: { field: 'views', operator: 'greaterThan', value: 5 } },
        },
      },
    };
    expect((await fetchUnder(lens)).map((row) => row.id)).toEqual([1]);
    for (const rule of [
      true,
      { field: 'id', operator: 'exists' },
      { field: 'posts', arrayOperator: 'any', condition: { field: 'id', operator: 'exists' } },
    ] as Condition[])
      expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
  });

  test.each<[string, Condition]>([
    ['equals', { field: 'org.parent.name', operator: 'equals', value: 'Acme' }],
    ['notEquals', { field: 'org.parent.name', operator: 'notEquals', value: 'Acme' }],
    ['notExists', { field: 'org.parent', operator: 'notExists' }],
  ])('a rule reading two hops turned on (%s) re-checks as the database does', async (_, rule) => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id'], relations: { org: { relations: { parent: {} } } } },
      mapDefaults: {
        prisma: { models: { Org: { where: { field: 'seats', operator: 'exists' } } } },
      },
    };
    expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
  });

  test('a relation that is off is neither fetched nor ruled on', async () => {
    const lens: LensNarrowing = { parent: base, root: { picks: ['id'], relations: { org: {} } } };
    expect(toLensSelect(lens).select.org).toEqual({
      select: {
        id: true,
        name: true,
        plan: true,
        seats: true,
        foundedAt: true,
        settings: true,
        parentId: true,
      },
    });
    const rows = await fetchUnder(lens);
    expect(rows.every((row) => !Object.hasOwn((row.org ?? {}) as object, 'parent'))).toBe(true);
    const picked: LensNarrowing = { parent: base, root: { picks: ['id', 'org'] } };
    expect(validateNarrowing(picked).errors.map((e) => e.code)).toEqual(['wrong_kind']);
    const rule: Condition = { field: 'org.parent.name', operator: 'equals', value: 'Acme' };
    const refused = await rails.run(rule, { lens });
    expect(refused.sql).toMatch(/leaves the lens/);
    expect(refused.prisma).toMatch(/leaves the lens/);
  });

  test('a spelled path with model defaults below it re-checks as the database does', async () => {
    // org.users re-enters User, so it is spelled; User.posts below it comes from the defaults.
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id'], relations: { org: { relations: { users: {} } } } },
      mapDefaults: { prisma: { models: { User: { relations: { posts: {} } } } } },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    const rule: Condition = {
      field: 'org.users',
      arrayOperator: 'any',
      condition: {
        field: 'posts',
        arrayOperator: 'any',
        condition: { field: 'title', operator: 'equals', value: 'hello' },
      },
    };
    expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
  });

  test('a relation shown with no column is fetched by its key alone, and re-checks as the database does', async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id'],
        where: { field: 'org', operator: 'exists' },
        relations: { posts: { picks: [] } },
      },
    };
    // Presence needs the rows: each is fetched by its key (the join key Post.authorId), hidden or
    // not — never another column.
    expect(toLensSelect(lens).select).toEqual({
      id: true,
      org: { select: { id: true } },
      posts: { select: { authorId: true } },
    });
    for (const rule of [
      { field: 'posts', arrayOperator: 'any', condition: true },
      { field: 'posts', arrayOperator: 'none', condition: true },
      { field: 'posts', arrayOperator: 'atLeast', count: 1, condition: true },
    ] as Condition[])
      expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
    // A viewer's projection carries no key.
    const shown = projectRows(lens, rails.rows as unknown as Record<string, unknown>[]);
    expect(JSON.stringify(shown)).not.toContain('authorId');
  });

  test.each<[string, Condition]>([
    ['notEquals', { field: 'org.name', operator: 'notEquals', value: 'x' }],
    ['exists', { field: 'org', operator: 'exists' }],
    ['notExists', { field: 'org', operator: 'notExists' }],
  ])('a clamp reading a relation that is off (%s) re-checks as the database does', async (_, rule) => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id'], relations: { org: { picks: ['id', 'name'] } } },
      mapDefaults: {
        prisma: {
          models: { Org: { where: { field: 'parent.plan', operator: 'equals', value: 'pro' } } },
        },
      },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    expect((toLensSelect(lens).select.org as { select: object }).select).toEqual({
      id: true,
      name: true,
      parent: { select: { plan: true } },
    });
    expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
  });
});

describe("a to-many relation's orderBy: rows come back in its order on every rail", () => {
  const ordered = (orderBy: { field: string; dir: 'asc' | 'desc' }[]): LensNarrowing => ({
    parent: base,
    root: { picks: ['id'], relations: { posts: { picks: ['id', 'views'], orderBy } } },
  });
  const postIds = (rows: Record<string, unknown>[]) =>
    rows.map((row) => (row.posts as { id: number }[]).map((post) => post.id));
  const fetchUnder = async (lens: LensNarrowing) =>
    (await rails.prisma.user.findMany({
      select: toLensSelect(lens).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];

  test('toLensSelect orders the relation, a nullable column NULLs last', () => {
    expect(toLensSelect(ordered([{ field: 'views', dir: 'desc' }])).select.posts).toEqual({
      select: { id: true, views: true },
      orderBy: [{ views: { sort: 'desc', nulls: 'last' } }],
    });
    // A required column takes Prisma's bare direction.
    expect(toLensSelect(ordered([{ field: 'id', dir: 'desc' }])).select.posts).toMatchObject({
      orderBy: [{ id: 'desc' }],
    });
  });

  test.each<['asc' | 'desc', number[]]>([
    ['desc', [100, 101, 103]],
    ['asc', [101, 100, 103]],
  ])('views %s: the database, projectRows over its rows and over the full rows agree', async (dir, user1) => {
    const lens = ordered([
      { field: 'views', dir },
      { field: 'id', dir: 'asc' },
    ]);
    const fetched = await fetchUnder(lens);
    expect(postIds(fetched)[0]).toEqual(user1);
    const full = rails.rows as unknown as Record<string, unknown>[];
    // The full rows, loaded in id order, come back in the lens's order.
    expect(postIds(projectRows(lens, full))).toEqual(postIds(fetched));
    expect(projectRows(lens, fetched)).toEqual(projectRows(lens, full));
  });

  test('a later layer replaces the order; it names only what its parent shows', () => {
    const first = ordered([{ field: 'views', dir: 'desc' }]);
    const second: LensNarrowing = {
      parent: first,
      root: { relations: { posts: { orderBy: [{ field: 'id', dir: 'desc' }] } } },
    };
    expect(validateNarrowing(second).ok).toBe(true);
    expect(postIds(projectRows(second, rails.rows as never))[0]).toEqual([103, 101, 100]);
    const hidden: LensNarrowing = {
      parent: { parent: base, root: { relations: { posts: { omits: ['views'] } } } },
      root: { relations: { posts: { orderBy: [{ field: 'views', dir: 'asc' }] } } },
    };
    expect(validateNarrowing(hidden).errors.map((e) => e.code)).toEqual(['not_visible']);
  });

  test('orders by numbers and dates only: a string, a relation, or an unknown column is refused', () => {
    const codes = (orderBy: unknown) =>
      validateNarrowing({
        parent: base,
        root: { relations: { posts: { orderBy: orderBy as never } } },
      }).errors.map((e) => e.code);
    expect(codes([{ field: 'title', dir: 'asc' }])).toEqual(['wrong_kind']);
    expect(codes([{ field: 'author', dir: 'asc' }])).toEqual(['wrong_kind']);
    expect(codes([{ field: 'nope', dir: 'asc' }])).toEqual(['not_in_lens']);
    expect(codes([{ field: 'views', dir: 'up' }])).toEqual(['invalid_order_by']);
    expect(codes({ field: 'views', dir: 'asc' })).toEqual(['invalid_order_by']);
  });

  test('a model default orders the model wherever a to-many relation reaches it', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id'], relations: { posts: { picks: ['id'] } } },
      mapDefaults: { prisma: { models: { Post: { orderBy: [{ field: 'id', dir: 'desc' }] } } } },
    };
    expect(postIds(projectRows(lens, rails.rows as never))[0]).toEqual([103, 101, 100]);
    expect(toLensSelect(lens).select.posts).toMatchObject({ orderBy: [{ id: 'desc' }] });
  });
});
