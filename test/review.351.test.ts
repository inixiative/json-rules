import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  executePrismaPlan,
  type FieldMap,
  indexBridges,
  type LensNarrowing,
  materializeSourceQuery,
  materializeSources,
  projectRows,
  type SourceEntry,
  type SourceQuery,
  toLensSelect,
  toSourceQueries,
  validateNarrowing,
  validateRule,
} from '../index';
import { map, openRails } from './rails/harness';

// 3.5.1: fail-closed and doc findings from the 3.5.0 adversarial review.

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

describe('toLensSelect selects the local columns a bridged source re-checks', () => {
  // `age` is hidden; the source reads it locally and the tier across the bridge.
  const lens: LensNarrowing = {
    parent: users,
    root: {
      omits: ['age'],
      relations: { 'crm:Profile': {} },
      sources: {
        name: rule({
          any: [
            { field: 'age', operator: 'greaterThan', value: 35 },
            { field: 'crm:Profile.tier', operator: 'equals', value: 'gold' },
          ],
        }),
      },
    },
  };

  test('materializeSources over toLensSelect rows + far side answers it', async () => {
    expect(validateNarrowing(lens).ok).toBe(true);
    const { select } = toLensSelect(lens);
    expect(select).toMatchObject({ age: true, id: true, name: true });
    const fetched = (await rails.prisma.user.findMany({ select } as never)) as Record<
      string,
      unknown
    >[];
    // Ann and Dee are gold; Dee is 40.
    expect(
      materializeSources(lens, fetched.map(withProfile))[0].options.map((o) => o.value),
    ).toEqual(['Ann', 'Dee']);
    // As the re-check keeps them too.
    const kept = projectRows(lens, fetched, { keepClampColumns: true }).map(withProfile);
    expect(materializeSources(lens, kept)[0].options.map((o) => o.value)).toEqual(['Ann', 'Dee']);
  });

  test("a viewer's projection never carries the fetch-only column", async () => {
    const { select } = toLensSelect(lens);
    const fetched = (await rails.prisma.user.findMany({ select } as never)) as Record<
      string,
      unknown
    >[];
    for (const row of projectRows(lens, fetched)) expect(Object.hasOwn(row, 'age')).toBe(false);
  });
});

describe('a label or axis across a to-many relation: validation and every posture refuse alike', () => {
  const events: FieldMap = {
    models: { Event: { fields: { id: s('Int'), userId: s('Int'), kind: s('String') } } },
  };
  const manyBridges = [
    {
      endpoints: [
        { fieldMap: 'prisma', model: 'User', on: 'id' },
        { fieldMap: 'crm', model: 'Event', on: 'userId' },
      ],
      cardinality: 'oneToMany',
    },
  ];
  const withEvents = createLens({
    maps: { prisma: map, crm: events },
    bridges: manyBridges,
    mapName: 'prisma',
    model: 'User',
  } as never);
  const at = (parent: typeof users, relation: string, source: SourceEntry): LensNarrowing => ({
    parent,
    root: { relations: { [relation]: {} }, sources: { name: source } },
  });
  const cases: [string, LensNarrowing][] = [
    ['a local label', at(users, 'posts', { label: 'posts.title' })],
    ['a local axis', at(users, 'posts', { groupBy: 'posts.title' })],
    ['a bridged label', at(withEvents, 'crm:Event', { label: 'crm:Event.kind' })],
    ['a bridged axis', at(withEvents, 'crm:Event', { groupBy: 'crm:Event.kind' })],
  ];
  const refusal = (run: () => unknown): { name: string; code?: string } | null => {
    try {
      run();
      return null;
    } catch (error) {
      return error as { name: string; code?: string };
    }
  };

  test.each(cases)('%s', (_, lens) => {
    const result = validateNarrowing(lens);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain('invalid_source');
    expect(result.errors.filter((e) => /to-many/.test(e.message)).length).toBe(1);
    for (const run of [() => toSourceQueries(lens), () => materializeSources(lens, [])]) {
      const thrown = refusal(run);
      expect(thrown?.name).toBe('LensRefusal');
      expect(thrown?.code).toBe('invalid_source');
    }
  });

  test('validateNarrowing ok exactly when no posture refuses', () => {
    const fine: LensNarrowing[] = [
      at(users, 'org', { label: 'org.name' }),
      at(users, 'org', { groupBy: 'org.plan' }),
      at(withEvents, 'crm:Event', true),
    ];
    for (const lens of [...fine, ...cases.map(([, lens]) => lens)]) {
      const refused =
        refusal(() => toSourceQueries(lens)) !== null ||
        refusal(() => materializeSources(lens, [])) !== null;
      expect(validateNarrowing(lens).ok).toBe(!refused);
    }
  });
});

describe('a re-check reading JSON selects the Json column whole', () => {
  const tierGold = { field: 'crm:Profile.tier', operator: 'equals', value: 'gold' };
  const source = (local: object): LensNarrowing => ({
    parent: users,
    root: {
      relations: { 'crm:Profile': {}, org: {} },
      sources: { name: rule({ any: [local, tierGold] }) },
    },
  });

  test('a local Json read: the column, on both rails', async () => {
    const lens = source({
      all: [
        { field: 'meta.a.b', operator: 'equals', value: 'X' },
        { field: 'meta.n', operator: 'isEmpty' },
      ],
    });
    const [query] = toSourceQueries(lens);
    expect(query.prisma.select).toEqual({ name: true, meta: true, id: true });
    expect(query.sql.sql).not.toBeNull();
    const { model: _model, steps: _steps, ...args } = query.prisma;
    const prisma = (await rails.prisma.user.findMany(args as never)) as Record<string, unknown>[];
    const sql = (await rails.db.query(query.sql.sql as string, query.sql.params)).rows as Record<
      string,
      unknown
    >[];
    // Dee's meta.a.b is 'X'; Ann and Dee are gold.
    for (const [shape, rows] of [
      ['prisma', prisma],
      ['sql', sql],
    ] as const)
      expect(
        materializeSourceQuery(query, rows.map(withProfile), { lens, rowShape: shape }).options.map(
          (o) => o.value,
        ),
      ).toEqual(['Ann', 'Dee']);
  });

  test('a Json read through a relation: the column under it, and SQL says relation', async () => {
    const lens = source({ field: 'org.settings.tier', operator: 'equals', value: 'gold' });
    const [query] = toSourceQueries(lens);
    expect(query.prisma.select).toEqual({
      name: true,
      org: { select: { settings: true } },
      id: true,
    });
    expect(query.sql.error).toMatch(/reads 'org\.settings' through a relation/);
    const { model: _model, steps: _steps, ...args } = query.prisma;
    const rows = (await rails.prisma.user.findMany(args as never)) as Record<string, unknown>[];
    // Ann's org (Acme) is gold; Dee is gold in the CRM.
    expect(
      materializeSourceQuery(query, rows.map(withProfile), { lens }).options.map((o) => o.value),
    ).toEqual(['Ann', 'Dee']);
  });
});

test('a count operator across a bridge says a bridge, not "not a relation"', () => {
  const events: FieldMap = {
    models: { Event: { fields: { id: s('Int'), userId: s('Int'), kind: s('String') } } },
  };
  const lens: LensNarrowing = {
    parent: createLens({
      maps: { prisma: map, crm: events },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'prisma', model: 'User', on: 'id' },
            { fieldMap: 'crm', model: 'Event', on: 'userId' },
          ],
          cardinality: 'oneToMany',
        },
      ],
      mapName: 'prisma',
      model: 'User',
    } as never),
    root: {
      relations: { 'crm:Event': {} },
      sources: {
        name: rule({
          field: 'crm:Event',
          arrayOperator: 'atLeast',
          count: 2,
          condition: { field: 'kind', operator: 'equals', value: 'x' },
        }),
      },
    },
  };
  const [issue] = validateNarrowing(lens).errors;
  expect(issue.message).toMatch(/count operators aren't supported across a bridge/);
  expect(issue.message).not.toMatch(/not a relation/);
  expect(() => toSourceQueries(lens)).toThrow(/count operators aren't supported across a bridge/);
});

describe('the README source-query snippet runs as written', () => {
  // README "Sources across a bridge" (and the snippet above it), against the rails client.
  const runSnippet = async (
    prisma: typeof rails.prisma,
    query: SourceQuery,
    lens: LensNarrowing,
    loadFarSide: (rows: Record<string, unknown>[]) => Promise<Record<string, unknown>[]>,
  ) => {
    const { distinct, select, where, steps } = query.prisma; // query.model === 'User'
    const candidates = await prisma.user.findMany({
      distinct,
      select,
      where: steps ? await executePrismaPlan({ steps }, prisma as never) : where,
    } as never);
    const rows = query.recheck === undefined ? candidates : await loadFarSide(candidates);
    return materializeSourceQuery(query, rows, { lens });
  };
  const load = async (rows: Record<string, unknown>[]) => rows.map(withProfile);

  test.each<[string, object, string[]]>([
    [
      'a plain where',
      { field: 'age', operator: 'greaterThan', value: 6 },
      ['Ann', 'Dee', 'nullable'],
    ],
    [
      'a bridged where (recheck)',
      { field: 'crm:Profile.tier', operator: 'equals', value: 'gold' },
      ['Ann', 'Dee'],
    ],
    [
      'a count step',
      {
        field: 'posts',
        arrayOperator: 'atLeast',
        count: 2,
        condition: { field: 'views', operator: 'greaterThan', value: 0 },
      },
      ['Ann'],
    ],
    ['a column reference', { field: 'age', operator: 'greaterThan', path: '$.orgId' }, ['Ann']],
  ])('%s', async (_, where, truth) => {
    const lens: LensNarrowing = {
      parent: users,
      root: { relations: { 'crm:Profile': {}, posts: {} }, sources: { name: rule(where) } },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    const [query] = toSourceQueries(lens);
    const { options } = await runSnippet(rails.prisma, query, lens, load);
    expect(options.map((o) => o.value)).toEqual(truth);
  });
});

describe('a count operator needs a condition and a count on every target', () => {
  const noCondition = rule({ field: 'posts', arrayOperator: 'atLeast', count: 2 });
  const noCount = rule({
    field: 'posts',
    arrayOperator: 'atLeast',
    condition: { field: 'views', operator: 'greaterThan', value: 0 },
  });

  test.each(['check', 'toPrisma', 'toSql'] as const)('validateRule for %s refuses', (target) => {
    const options = { target, map, model: 'User' };
    expect(validateRule(noCondition, options).errors.map((e) => e.code)).toContain(
      'missing_condition',
    );
    expect(validateRule(noCount, options).errors.map((e) => e.code)).toContain('missing_count');
  });

  test.each([
    ['no condition', noCondition],
    ['no count', noCount],
  ])('a source with %s: validateNarrowing and toSourceQueries agree', (_, where) => {
    const lens: LensNarrowing = {
      parent: users,
      root: { relations: { posts: {} }, sources: { name: where } },
    };
    expect(validateNarrowing(lens).ok).toBe(false);
    expect(() => toSourceQueries(lens)).toThrow();
  });
});
