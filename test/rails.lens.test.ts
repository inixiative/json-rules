import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  check,
  createLens,
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
});
