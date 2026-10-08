import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
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
    root: { where: { field: 'age', operator: 'greaterThanEquals', value: 5 } },
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

  test('a lens with map / mapName / model is refused', () => {
    expect(() => toPrisma(true, { lens, map })).toThrow(/not both/);
    expect(() => toSql(true, { lens, model: 'User' })).toThrow(/not both/);
  });
});

describe("toLensSelect: a to-many relation's grants as its where agree with check()", () => {
  const lens: LensNarrowing = {
    parent: base,
    root: {
      picks: ['id', 'name', 'posts', 'org'],
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
  const fetchUnder = async (lens: LensNarrowing, rules: Condition[] = []) => {
    const where = await executePrismaPlan(toPrisma(true, { lens }), rails.prisma as never);
    const rows = (await rails.prisma.user.findMany({
      where: where as never,
      select: toLensSelect(lens, { rules }).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];
    return projectRows(lens, rows, { keepGrantColumns: true, rules });
  };
  const recheck = async (lens: LensNarrowing, rule: Condition) =>
    (await fetchUnder(lens, [rule]))
      .filter((row) => check(narrowRule(rule, lens), row) === true)
      .map((row) => row.id);
  const database = async (lens: LensNarrowing, rule: Condition) =>
    (await rails.run(rule, { lens })).prisma as unknown[];

  test("a to-one grant reading a narrowed list reads it whole: org 10's hidden user hides it", async () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'org'],
        relations: {
          org: {
            picks: ['id', 'name', 'users'],
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
        picks: ['id', 'posts'],
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
  ])('a rule reading past the declared paths (%s) re-checks as the database does', async (_, rule) => {
    const lens: LensNarrowing = {
      parent: base,
      root: { picks: ['id', 'org'] },
      mapDefaults: {
        prisma: { models: { Org: { where: { field: 'seats', operator: 'exists' } } } },
      },
    };
    expect(await recheck(lens, rule)).toEqual(await database(lens, rule));
  });
});
