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

  test("a to-one hop's grant keeps the rows where the hop is missing for a negation", async () => {
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

describe("toLensSelect: a to-many relation's grants as its where agree with check()", () => {
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
    // Pre-narrowed: user 1 keeps only the post whose views pass the grant.
    expect((fetched[0].posts as { id: number }[]).map((p) => p.id)).toEqual([100]);
    const options = { keepGrantColumns: true };
    expect(projectRows(lens, fetched, options)).toEqual(
      projectRows(lens, rails.rows as unknown as Record<string, unknown>[], options),
    );
  });

  test('projected rows re-test the grants: a narrowed check reads the kept columns', async () => {
    const fetched = await fetchUnderLens();
    const rows = projectRows(lens, fetched, { keepGrantColumns: true });
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
    const rows = projectRows(lens, await fetchUnderLens(), { keepGrantColumns: true });
    const ids = rows.filter((row) => check(narrowRule(rule, lens), row) === true).map((r) => r.id);
    expect(ids).toEqual((await rails.run(rule, { lens })).prisma as number[]);
  });

  test('without keepGrantColumns a hidden to-one row is null', async () => {
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
    return projectRows(lens, rows, { keepGrantColumns: true });
  };
  const recheck = async (lens: LensNarrowing, rule: Condition) =>
    (await fetchUnder(lens))
      .filter((row) => check(narrowRule(rule, lens), row) === true)
      .map((row) => row.id);
  const database = async (lens: LensNarrowing, rule: Condition) =>
    (await rails.run(rule, { lens })).prisma as unknown[];

  test("a to-one grant reading a narrowed list reads it whole: org 10's hidden user hides it", async () => {
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
        keepGrantColumns: true,
      }),
    );
  });

  test('a root grant reading a narrowed list keeps the row the database keeps', async () => {
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

  test('a grant reading a relation that is off for presence fetches its key alone', async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id'],
        where: { field: 'org', operator: 'exists' },
        relations: { posts: { picks: [] } },
      },
    };
    expect(toLensSelect(lens).select).toEqual({
      id: true,
      org: { select: { id: true } },
      posts: { select: { authorId: true } },
    });
    const rule: Condition = {
      field: 'posts',
      arrayOperator: 'any',
      condition: true,
    };
    expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
  });

  test.each<[string, Condition]>([
    ['notEquals', { field: 'org.name', operator: 'notEquals', value: 'x' }],
    ['exists', { field: 'org', operator: 'exists' }],
    ['notExists', { field: 'org', operator: 'notExists' }],
  ])('a grant reading a relation that is off (%s) re-checks as the database does', async (_, rule) => {
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
