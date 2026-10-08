import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  executePrismaPlan,
  type FieldMap,
  type LensNarrowing,
  materializeSourceQuery,
  materializeSources,
  projectRows,
  type SourceQuery,
  toLensSelect,
  toPrisma,
  toSourceQueries,
  validateNarrowing,
  validateRule,
} from '../index';
import { map, openRails } from './rails/harness';

// The adversarial review of 3.4 (round 10): each finding's repro, failing first. Expected options
// come from an independent oracle — the seeded rows walked down the path by hand, each level's
// grant a plain predicate — never from the lens's own plan.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;
type Row = Record<string, unknown>;

const SEED = `
INSERT INTO orgs (id, name, plan, seats, "parentId") VALUES (13, 'Zed', 'pro', NULL, 10), (14, 'Q', NULL, 3, NULL), (15, 'R', 'free', 9, 14);
INSERT INTO users (id, name, age, tags, "orgId") VALUES (30, 'Cy', 8, '{}', 10), (31, 'Dot', 20, '{}', 13), (32, 'Eve', 40, '{}', 15), (33, 'Fay', 50, '{}', 14);
INSERT INTO posts (id, "authorId", views, title) VALUES (120, 30, 4, 'cy-post'), (121, 32, 9, 'eve-post');
`;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(SEED);
});
afterAll(async () => {
  await rails.close();
});

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const values = (options: readonly { value: string }[] | null | undefined) =>
  options?.map((o) => o.value) ?? null;
const sorted = (all: unknown[]) =>
  [...new Set(all.filter((v) => v !== null && v !== undefined).map(String))].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );

// The oracle: every user row, the path's relations included as Prisma loads them; walked by hand.
const include = (segs: readonly string[]): object =>
  segs.length === 0
    ? {}
    : { include: { [segs[0]]: segs.length === 1 ? true : include(segs.slice(1)) } };
const oracle = async (
  segs: string[],
  field: string,
  keep: ((row: Row) => boolean)[],
): Promise<string[]> => {
  const users = (await rails.prisma.user.findMany(include(segs) as never)) as Row[];
  const walk = (rows: Row[], i: number): Row[] => {
    const kept = rows.filter(keep[i] ?? (() => true));
    if (i === segs.length) return kept;
    return kept.flatMap((row) => {
      const next = row[segs[i]];
      return walk(Array.isArray(next) ? (next as Row[]) : next ? [next as Row] : [], i + 1);
    });
  };
  return sorted(walk(users, 0).map((row) => row[field]));
};

/** Every rail's options for the lens's one source: the option query on Prisma and SQL, and
 *  materializeSources over the library's own fetch, as fetched and as projectRows keeps it. */
const rails3 = async (lens: LensNarrowing) => {
  expect(validateNarrowing(lens).ok).toBe(true);
  const [query] = toSourceQueries(lens) as [SourceQuery];
  const delegates = rails.prisma as unknown as Record<
    string,
    { findMany: (args: object) => Promise<object[]> }
  >;
  let prisma: string[] | null = null;
  if (query.prisma) {
    const { model, steps, ...args } = query.prisma;
    const where = steps
      ? await executePrismaPlan({ steps } as never, rails.prisma as never)
      : args.where;
    const rows = await delegates[model.charAt(0).toLowerCase() + model.slice(1)].findMany({
      ...args,
      where,
    });
    prisma = values(materializeSourceQuery(query, rows as never).options);
  }
  const sql =
    query.sql.sql === null
      ? null
      : values(
          materializeSourceQuery(
            query,
            (await rails.db.query(query.sql.sql, query.sql.params)).rows as never,
            { rowShape: 'sql' },
          ).options,
        );
  const where = await executePrismaPlan(toPrisma(true, { lens }), rails.prisma as never);
  const fetched = (await rails.prisma.user.findMany({
    where: where as never,
    select: toLensSelect(lens).select as never,
  })) as Row[];
  const kept = projectRows(lens, fetched, { keepGrantColumns: true });
  return {
    prisma,
    sql,
    fetched: values(materializeSources(lens, fetched)[0].options),
    kept: values(materializeSources(lens, kept)[0].options),
  };
};

const nest = (segs: string[], leaf: object): object =>
  segs.length === 0 ? leaf : { relations: { [segs[0]]: nest(segs.slice(1), leaf) } };

describe('R10-1: a path source offers exactly the rows reachable down its path', () => {
  const pro = (row: Row) => row.plan === 'pro';
  const adult = (row: Row) => typeof row.age === 'number' && row.age >= 5;
  const first = (row: Row) => row.id === 1;
  test.each<
    [string, string[], string, Condition | null, Record<string, Condition>, ((r: Row) => boolean)[]]
  >([
    ['to-one then to-many (users in my org)', ['org', 'users'], 'name', null, {}, []],
    [
      '… under a root grant',
      ['org', 'users'],
      'name',
      rule({ field: 'id', operator: 'equals', value: 1 }),
      {},
      [first],
    ],
    [
      '… under a relation grant',
      ['org', 'users'],
      'name',
      null,
      { Org: rule({ field: 'plan', operator: 'equals', value: 'pro' }) },
      [() => true, pro],
    ],
    [
      'to-many then to-one',
      ['posts', 'author'],
      'name',
      rule({ field: 'age', operator: 'greaterThanEquals', value: 5 }),
      {},
      [adult],
    ],
    ['to-one, to-many, to-many', ['org', 'children', 'users'], 'name', null, {}, []],
    ['up then down a self-relation', ['org', 'parent', 'children'], 'name', null, {}, []],
    [
      'up then down, granted',
      ['org', 'parent', 'children'],
      'name',
      rule({ field: 'age', operator: 'greaterThanEquals', value: 5 }),
      { Org: rule({ field: 'plan', operator: 'equals', value: 'pro' }) },
      [adult, pro, pro, pro],
    ],
    [
      'to-many, to-one, to-one',
      ['posts', 'author', 'org'],
      'name',
      rule({ field: 'age', operator: 'greaterThanEquals', value: 5 }),
      {},
      [adult],
    ],
  ])('%s', async (_, segs, field, rootWhere, defaults, keep) => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        ...(rootWhere && { where: rootWhere }),
        ...nest(segs, { sources: { [field]: true } }),
      } as never,
      ...(Object.keys(defaults).length && {
        mapDefaults: {
          prisma: {
            models: Object.fromEntries(
              Object.entries(defaults).map(([m, where]) => [m, { where }]),
            ),
          },
        },
      }),
    };
    const want = await oracle(segs, field, keep);
    expect(want.length).toBeGreaterThan(0);
    const got = await rails3(lens);
    expect(got).toEqual({
      prisma: want,
      sql: got.sql === null ? null : want,
      fetched: want,
      kept: want,
    });
  });
});

describe('R10-2: the fetch reads a source below its visit, never the inverse path back up', () => {
  test('a source at a deep visit fetches what the same lens fetches without it, plus its columns', async () => {
    const mk = (sources: boolean): LensNarrowing => ({
      parent: base,
      root: {
        picks: ['id'],
        relations: {
          org: {
            picks: ['id'],
            relations: {
              parent: { picks: ['id', 'name'], ...(sources && { sources: { name: true } }) },
            },
          },
        },
      },
    });
    const size = async (lens: LensNarrowing) =>
      JSON.stringify(
        await rails.prisma.user.findMany({ select: toLensSelect(lens).select as never }),
      ).length;
    expect(await size(mk(true))).toBeLessThanOrEqual(1.5 * (await size(mk(false))));
    expect(JSON.stringify(toLensSelect(mk(true)).select)).not.toContain('children');
  });
});

describe('R10-5: materializeSources refuses rows a viewer projection cut', () => {
  test('a row lacking a column the source reads is a usage error, not fewer options', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        picks: ['id', 'name'],
        sources: { name: rule({ field: 'age', operator: 'notEquals', value: 30 }) },
      },
    };
    const fetched = [
      { id: 1, name: 'Ann', age: 30 },
      { id: 2, name: 'bob', age: null },
    ];
    expect(values(materializeSources(lens, fetched)[0].options)).toEqual(['bob']);
    expect(() => materializeSources(lens, projectRows(lens, fetched))).toThrow(
      /fetched or keepGrantColumns rows/,
    );
  });
});

describe('R10-6/7/8: a source across a bridge over-fetches its local side, and says what to supply', () => {
  const maps = {
    prisma: {
      models: { FanUser: { fields: { id: s('String'), email: s('String'), crmId: s('String') } } },
    },
    salesforce: { models: { Contact: { fields: { id: s('String'), industry: s('String') } } } },
  } as Record<string, FieldMap>;
  const bridged = createLens({
    maps,
    bridges: [
      {
        endpoints: [
          { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
          { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
        ],
        cardinality: 'oneToMany',
      },
    ],
    mapName: 'prisma',
    model: 'FanUser',
  } as never);
  const rows = [
    { id: 'u1', email: 'a@x', crmId: 'c1', 'salesforce:Contact': { id: 'c1', industry: 'tech' } },
    { id: 'u2', email: 'b@x', crmId: 'c2', 'salesforce:Contact': { id: 'c2', industry: 'retail' } },
  ];
  const tech = rule({ field: 'salesforce:Contact.industry', operator: 'equals', value: 'tech' });
  test.each<[string, LensNarrowing, string[]]>([
    [
      'a where across it',
      {
        parent: bridged,
        root: {
          relations: { 'salesforce:Contact': {} },
          sources: {
            email: rule({
              field: 'salesforce:Contact.industry',
              operator: 'notEquals',
              value: 'tech',
            }),
          },
        },
      },
      ['b@x'],
    ],
    [
      'a label across it',
      {
        parent: bridged,
        root: {
          relations: { 'salesforce:Contact': {} },
          sources: { email: { label: 'salesforce:Contact.industry' } },
        },
      },
      ['b@x', 'a@x'],
    ],
    [
      'an axis across it',
      {
        parent: bridged,
        root: {
          relations: { 'salesforce:Contact': {} },
          sources: { email: { groupBy: 'salesforce:Contact.industry' } },
        },
      },
      ['b@x', 'a@x'],
    ],
    [
      'a pointer whose model source crosses it',
      {
        parent: bridged,
        root: {
          relations: { 'salesforce:Contact': {} },
          sources: { email: { from: 'mapDefaults' } },
        },
        mapDefaults: { prisma: { models: { FanUser: { sources: { email: tech } } } } },
      },
      ['a@x'],
    ],
  ])('%s', (_, lens, expected) => {
    expect(validateNarrowing(lens).ok).toBe(true);
    const [query] = toSourceQueries(lens);
    expect(query.recheck).toBeDefined();
    expect(query.prisma.where).toEqual({});
    expect(query.prisma.select).toEqual({ email: true, crmId: true });
    expect(query.sql.sql).not.toContain('salesforce');
    expect(JSON.stringify(toLensSelect(lens).select)).not.toContain('salesforce');
    expect(values(materializeSourceQuery(query, rows, { lens }).options)).toEqual(expected);
    // Rows without the bridged side can't answer it.
    const fetched = rows.map(({ 'salesforce:Contact': _side, ...row }) => row);
    expect(() => materializeSourceQuery(query, fetched, { lens })).toThrow(/salesforce:Contact/);
    if ('from' in (lens.root?.sources?.email as object)) {
      expect(() => materializeSources(lens, rows)).toThrow(/toSourceQueries/);
      return;
    }
    expect(values(materializeSources(lens, rows)[0].options)).toEqual(expected);
    expect(() => materializeSources(lens, fetched)).toThrow(/salesforce:Contact/);
  });
});

describe('R10-3/4: what toPrisma compiles of a literal, the validator says', () => {
  const at = {
    target: 'toPrisma' as const,
    map: { maps: { prisma: map } },
    mapName: 'prisma',
    model: 'User',
  };
  test.each([
    [
      'a case-insensitive member of a list column, by set',
      rule({ field: 'tags', operator: 'in', value: ['A'], caseInsensitive: true }),
      true,
    ],
    [
      '… and its negation',
      rule({ field: 'tags', operator: 'notIn', value: ['A'], caseInsensitive: true }),
      true,
    ],
    [
      'a case-insensitive Json member',
      rule({ field: 'meta', operator: 'contains', value: 'A', caseInsensitive: true }),
      false,
    ],
    [
      'a case-insensitive Json equality',
      rule({ field: 'meta', operator: 'equals', value: 'a%b', caseInsensitive: true }),
      false,
    ],
    ['a list holding null', rule({ field: 'tags', operator: 'equals', value: [null] }), false],
    [
      'an element condition over a scalar list',
      rule({
        field: 'tags',
        arrayOperator: 'any',
        condition: { field: '$', operator: 'equals', value: 'a' },
      }),
      false,
    ],
  ])('%s', (_, r, compiles) => {
    let threw = false;
    try {
      toPrisma(r, { map: { maps: { prisma: map } }, mapName: 'prisma', model: 'User' });
    } catch {
      threw = true;
    }
    expect(!threw).toBe(compiles);
    expect(validateRule(r, at).ok).toBe(compiles);
  });

  test('a grant or source a compile refuses is a refusal from the lens, never a plain Error', () => {
    const orgBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Org' });
    const grant = rule({ field: 'meta', operator: 'contains', value: 'A', caseInsensitive: true });
    const asGrant: LensNarrowing = {
      parent: orgBase,
      root: { relations: { users: { where: grant } } },
    };
    const asSource: LensNarrowing = {
      parent: orgBase,
      root: { relations: { users: { sources: { name: grant } } } },
    };
    for (const [lens, run] of [
      [asGrant, () => toLensSelect(asGrant)],
      [asSource, () => toSourceQueries(asSource)],
    ] as const) {
      expect(validateNarrowing(lens).ok).toBe(false);
      try {
        run();
        throw new Error('compiled');
      } catch (error) {
        expect((error as Error).constructor.name).toBe('LensRefusal');
      }
    }
  });
});
