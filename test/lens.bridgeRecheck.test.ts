import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  type FieldMap,
  indexBridges,
  type LensNarrowing,
  materializeSourceQuery,
  materializeSources,
  type SourceOption,
  type SourceQuery,
  toSourceQueries,
  validateNarrowing,
} from '../index';
import { map, openRails } from './rails/harness';

// 3.4.1: a source across a bridge gets a real query for the side the database holds — what reads
// across the bridge folded to TRUE, so its rows are a superset — and a `recheck` the caller runs
// over the candidates once the far side is loaded onto them. Users live in PGlite (the rails
// fixture); their CRM profiles live in memory, as a second source does.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

const crm: FieldMap = {
  models: { Profile: { fields: { id: s('Int'), userId: s('Int'), tier: s('String') } } },
};
const bridges = [
  {
    endpoints: [
      { fieldMap: 'prisma', model: 'User', on: 'id' },
      { fieldMap: 'crm', model: 'Profile', on: 'userId' },
    ],
    cardinality: 'oneToOne',
  },
];
const maps = { prisma: map, crm };
// Users 1 Ann (age 30), 2 bob (NULL), 3 NULL name (5), 4 Dee (40), 5 nullable (7); 3 and 5 have
// no profile.
const profiles = [
  { id: 1, userId: 1, tier: 'gold' },
  { id: 2, userId: 2, tier: 'silver' },
  { id: 3, userId: 4, tier: 'gold' },
];
const users = createLens({ maps, bridges, mapName: 'prisma', model: 'User' } as never);
const dict = indexBridges({ maps, bridges } as never, { 'crm:Profile': profiles });
const profileOf = (row: Record<string, unknown>) =>
  (dict.crm.Profile.userId as Record<string, unknown>)[String(row.id)] ?? null;
const withProfile = (row: Record<string, unknown>) => ({ ...row, 'crm:Profile': profileOf(row) });

/** A query run on both database rails: the candidate rows each returns. */
const candidates = async (query: SourceQuery) => {
  const { model, steps: _steps, ...args } = query.prisma;
  const delegate = (
    rails.prisma as unknown as Record<string, { findMany: (a: object) => Promise<object[]> }>
  )[model.toLowerCase()];
  const prisma = (await delegate.findMany(args)) as Record<string, unknown>[];
  expect(query.sql.sql).not.toBeNull();
  const sql = (await rails.db.query(query.sql.sql as string, query.sql.params)).rows as Record<
    string,
    unknown
  >[];
  return { prisma, sql };
};

const values = (options: readonly SourceOption[]) => options.map((o) => o.value);

describe('a source across a bridge over-fetches, and its recheck decides', () => {
  const tierNotGold = rule({ field: 'crm:Profile.tier', operator: 'notEquals', value: 'gold' });
  const cases: [string, LensNarrowing, SourceOption[]][] = [
    [
      'a where on the far column (notEquals keeps the user with no profile)',
      {
        parent: users,
        root: { relations: { 'crm:Profile': {} }, sources: { name: tierNotGold } },
      },
      [{ value: 'bob' }, { value: 'nullable' }],
    ],
    [
      'a where with a local conjunct, which the database still decides',
      {
        parent: users,
        root: {
          relations: { 'crm:Profile': {} },
          sources: {
            name: rule({ all: [{ field: 'age', operator: 'greaterThan', value: 6 }, tierNotGold] }),
          },
        },
      },
      [{ value: 'nullable' }],
    ],
    [
      'a label across it',
      {
        parent: users,
        root: {
          relations: { 'crm:Profile': {} },
          sources: { name: { label: 'crm:Profile.tier' } },
        },
      },
      [
        { value: 'Ann', label: 'gold' },
        { value: 'Dee', label: 'gold' },
        { value: 'nullable' },
        { value: 'bob', label: 'silver' },
      ],
    ],
    [
      'an axis across it',
      {
        parent: users,
        root: {
          relations: { 'crm:Profile': {} },
          sources: { name: { groupBy: 'crm:Profile.tier' } },
        },
      },
      [
        { value: 'nullable' },
        { value: 'Ann', groups: ['gold'] },
        { value: 'Dee', groups: ['gold'] },
        { value: 'bob', groups: ['silver'] },
      ],
    ],
    [
      'a pointer whose model source crosses it',
      {
        parent: users,
        root: { relations: { 'crm:Profile': {} }, sources: { name: { from: 'mapDefaults' } } },
        mapDefaults: {
          prisma: {
            models: {
              User: {
                sources: {
                  name: rule({ field: 'crm:Profile.tier', operator: 'equals', value: 'gold' }),
                },
              },
            },
          },
        },
      },
      [{ value: 'Ann' }, { value: 'Dee' }],
    ],
  ];

  test.each(cases)('%s', async (_, lens, truth) => {
    expect(validateNarrowing(lens).ok).toBe(true);
    const [query] = toSourceQueries(lens);
    expect(query.recheck).toBeDefined();
    // Candidates carry the bridge's local key; DISTINCT on the value would drop some.
    expect(query.prisma.select).toMatchObject({ name: true, id: true });
    expect(query.prisma.distinct).toBeUndefined();
    const rows = await candidates(query);
    for (const shape of ['prisma', 'sql'] as const) {
      // Superset: the database never misses a true option.
      const fetched = new Set(rows[shape].map((row) => row.name));
      for (const { value } of truth) expect(fetched.has(value)).toBe(true);
      // Candidates + far side + recheck = the truth.
      const loaded = rows[shape].map(withProfile);
      expect(materializeSourceQuery(query, loaded, { lens, rowShape: shape }).options).toEqual(
        truth,
      );
    }
    // The fetched-tree posture agrees, from root rows holding the far side (a pointer is queried).
    if (!('from' in (lens.root?.sources?.name as object))) {
      const all = (await rails.prisma.user.findMany()).map(withProfile);
      expect(materializeSources(lens, all)[0].options).toEqual(truth);
    }
  });

  test('the recheck is only what the database could not decide', () => {
    const [, local] = cases;
    const [query] = toSourceQueries(local[1]);
    expect(query.recheck).toEqual(tierNotGold);
    expect(query.prisma.where).toEqual({ age: { gt: 6 } });
    const [, label] = cases.slice(2);
    expect(toSourceQueries(label[1])[0].recheck).toBe(true);
  });

  test('a path source past the bridge: the clamps above are carried back across it', async () => {
    const profilesRoot = createLens({ maps, bridges, mapName: 'crm', model: 'Profile' } as never);
    const lens: LensNarrowing = {
      parent: profilesRoot,
      root: {
        where: rule({ field: 'tier', operator: 'equals', value: 'gold' }),
        relations: { 'prisma:User': { sources: { name: true } } },
      },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    const [query] = toSourceQueries(lens);
    expect([query.mapName, query.model]).toEqual(['prisma', 'User']);
    expect(query.recheck).toEqual({
      all: [
        { field: 'crm:Profile', operator: 'exists' },
        { field: 'crm:Profile.tier', operator: 'equals', value: 'gold' },
      ],
    });
    const rows = await candidates(query);
    for (const shape of ['prisma', 'sql'] as const) {
      expect(rows[shape].map((row) => row.name).filter(Boolean).length).toBe(4);
      const loaded = rows[shape].map(withProfile);
      expect(
        values(materializeSourceQuery(query, loaded, { lens, rowShape: shape }).options),
      ).toEqual(['Ann', 'Dee']);
    }
  });

  test('a source that reads no bridge is unchanged: no recheck, DISTINCT on the value', () => {
    const [query] = toSourceQueries({
      parent: users,
      root: { sources: { name: rule({ field: 'age', operator: 'greaterThan', value: 6 }) } },
    });
    expect('recheck' in query).toBe(false);
    expect(query.prisma).toEqual({
      model: 'User',
      distinct: ['name'],
      select: { name: true },
      where: { age: { gt: 6 } },
    });
  });

  describe('misuse: candidates without the far side are a UsageError, never a wrong set', () => {
    const [[, lens]] = cases;
    const [query] = toSourceQueries(lens);
    const rows = [
      { name: 'Ann', id: 1 },
      { name: 'bob', id: 2 },
    ];
    const thrown = (run: () => unknown): Error => {
      try {
        run();
      } catch (error) {
        expect((error as Error).name).toBe('UsageError');
        return error as Error;
      }
      throw new Error('did not throw');
    };
    test('no lens', () => {
      expect(thrown(() => materializeSourceQuery(query, rows.map(withProfile))).message).toMatch(
        /candidates; pass \{ lens \}/,
      );
    });
    test('the far side not loaded', () => {
      expect(thrown(() => materializeSourceQuery(query, rows, { lens })).message).toMatch(
        /lacks 'crm:Profile'/,
      );
    });
    test('the far side without the column the recheck reads', () => {
      const partial = rows.map((row) => ({ ...row, 'crm:Profile': { id: row.id } }));
      expect(thrown(() => materializeSourceQuery(query, partial, { lens })).message).toMatch(
        /lacks 'crm:Profile.tier'/,
      );
    });
    test('the far side as a list where the bridge names one row', () => {
      const listed = rows.map((row) => ({ ...row, 'crm:Profile': [profileOf(row)] }));
      expect(thrown(() => materializeSourceQuery(query, listed, { lens })).message).toMatch(
        /holds a list where it names one row/,
      );
    });
  });
});
