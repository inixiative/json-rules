import { describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  type FieldMap,
  type LensNarrowing,
  LensRefusal,
  materializeSourceQuery,
  materializeSources,
  projectRows,
  toPrisma,
  toSourceQueries,
  toSql,
  UsageError,
  validateNarrowing,
} from '../index';
import { map } from './rails/harness';

// The adversarial review of 3.4 (round 11): each finding's repro, failing first.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;
const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const values = (run: () => readonly { options: readonly { value: string }[] }[]) =>
  run()[0].options.map((o) => o.value);
const thrown = (run: () => unknown): Error | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error as Error;
  }
};

// A user row as the library fetches one: every selected key present, NULL as null.
const user = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  age: 1,
  score: 1,
  createdAt: null,
  meta: null,
  tags: [],
  role: null,
  orgId: null,
  ...extra,
});
const org = (id: number, plan: string | null) => ({
  id,
  name: `o${id}`,
  plan,
  seats: 1,
  foundedAt: null,
  settings: null,
  parentId: null,
});

describe('R11-F1: materializeSources requires every key a read walks, not only the first', () => {
  test('a hidden column of a to-one row (viewer rows) is refused, not over-offered', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        relations: { org: { omits: ['plan'] } },
        sources: { name: rule({ field: 'org.plan', operator: 'notEquals', value: 'free' }) },
      },
    };
    const fetched = [
      user(1, 'Ann', { orgId: 10, org: org(10, 'pro') }),
      user(3, 'Cy', { orgId: 12, org: org(12, 'free') }),
    ];
    expect(values(() => materializeSources(lens, fetched))).toEqual(['Ann']);
    expect(thrown(() => materializeSources(lens, projectRows(lens, fetched)))?.message).toMatch(
      /lacks 'org.plan'/,
    );
  });

  test('a hidden column of list elements is refused', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        relations: { posts: { omits: ['views'] } },
        sources: {
          name: rule({
            field: 'posts',
            arrayOperator: 'none',
            condition: { field: 'views', operator: 'greaterThan', value: 4 },
          }),
        },
      },
    };
    const post = (id: number, authorId: number, views: number) => ({
      id,
      authorId,
      views,
      title: 't',
    });
    const fetched = [
      user(1, 'Ann', { posts: [post(100, 1, 10)] }),
      user(2, 'Bob', { posts: [post(101, 2, 1)] }),
    ];
    expect(values(() => materializeSources(lens, fetched))).toEqual(['Bob']);
    expect(thrown(() => materializeSources(lens, projectRows(lens, fetched)))?.message).toMatch(
      /lacks 'posts.views'/,
    );
  });

  test('no false positives: a null to-one row, an empty list, a to-one label', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        relations: { org: {}, posts: {} },
        sources: {
          name: {
            label: 'org.name',
            where: rule({
              all: [
                { field: 'org.plan', operator: 'notEquals', value: 'free' },
                {
                  field: 'posts',
                  arrayOperator: 'none',
                  condition: { field: 'views', operator: 'exists' },
                },
              ],
            }),
          },
        },
      },
    };
    const fetched = [
      user(1, 'Ann', { orgId: null, org: null, posts: [] }),
      user(2, 'Bob', { orgId: 10, org: org(10, 'pro'), posts: [] }),
    ];
    expect(materializeSources(lens, fetched)[0].options).toEqual([
      { value: 'Ann' },
      { value: 'Bob', label: 'o10' },
    ]);
  });

  const bridgedMaps = {
    prisma: {
      models: { FanUser: { fields: { id: s('String'), email: s('String'), crmId: s('String') } } },
    },
    salesforce: { models: { Contact: { fields: { id: s('String'), industry: s('String') } } } },
  } as Record<string, FieldMap>;
  const bridged = createLens({
    maps: bridgedMaps,
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
    { id: 'u3', email: 'c@x', crmId: 'c3', 'salesforce:Contact': null },
  ];

  test('caller rows across a bridge must hold the far column, as one row where it is one', () => {
    const lens: LensNarrowing = {
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
    };
    expect(values(() => materializeSources(lens, rows))).toEqual(['b@x', 'c@x']);
    const farSideLacks = rows.map((r) => ({
      ...r,
      'salesforce:Contact': r['salesforce:Contact'] && { id: r['salesforce:Contact'].id },
    }));
    expect(thrown(() => materializeSources(lens, farSideLacks))?.message).toMatch(
      /lacks 'salesforce:Contact.industry'/,
    );
    const farSideList = rows.map((r) => ({
      ...r,
      'salesforce:Contact': r['salesforce:Contact'] ? [r['salesforce:Contact']] : [],
    }));
    expect(thrown(() => materializeSources(lens, farSideList))?.message).toMatch(
      /'salesforce:Contact' holds a list/,
    );
  });

  test('R11-F2: a source past a bridge is routed to caller rows, never compiled to false', () => {
    for (const [where, expected] of [
      [null, ['retail', 'tech']],
      [rule({ field: 'email', operator: 'exists' }), ['tech']],
    ] as const) {
      const lens: LensNarrowing = {
        parent: bridged,
        root: {
          ...(where && { where }),
          relations: { 'salesforce:Contact': { sources: { industry: true } } },
        },
      };
      expect(validateNarrowing(lens).ok).toBe(true);
      const [query] = toSourceQueries(lens);
      // The query reads Contact alone; the link to a FanUser (and its clamp) is the recheck.
      expect(query.model).toBe('Contact');
      expect(query.prisma.where).toEqual({});
      expect(query.recheck).toEqual({
        field: 'prisma:FanUser',
        arrayOperator: 'any',
        condition: where ?? true,
      });
      const supplied = [rows[0], { ...rows[1], email: where ? null : 'b@x' }];
      expect(values(() => materializeSources(lens, supplied))).toEqual([...expected]);
      // The same set from the query's candidates, each holding its FanUsers inline.
      const contacts = [
        { id: 'c1', industry: 'tech', 'prisma:FanUser': [supplied[0]] },
        { id: 'c2', industry: 'retail', 'prisma:FanUser': [supplied[1]] },
        { id: 'c9', industry: 'unlinked', 'prisma:FanUser': [] },
      ];
      expect(values(() => [materializeSourceQuery(query, contacts, { lens })])).toEqual([
        ...expected,
      ]);
    }
  });
});

describe('R11-F2: a clamp no inverse can carry is a refusal, not an empty list', () => {
  test('a one-sided relation under a root clamp', () => {
    const oneSided: FieldMap = {
      models: {
        User: {
          fields: {
            id: s('String'),
            age: s('Int'),
            posts: { kind: 'object', type: 'Post', isList: true },
          },
        },
        Post: { fields: { id: s('String'), title: s('String'), authorId: s('String') } },
      },
    };
    const lens: LensNarrowing = {
      parent: createLens({ maps: { app: oneSided }, mapName: 'app', model: 'User' }),
      root: {
        where: rule({ field: 'age', operator: 'greaterThan', value: 1 }),
        relations: { posts: { sources: { title: true } } },
      },
    };
    expect(
      validateNarrowing(lens)
        .errors.map((e) => e.message)
        .join(),
    ).toMatch(/no inverse/);
    expect(thrown(() => toSourceQueries(lens))).toBeInstanceOf(LensRefusal);
  });
});

describe('R11-F3: the caller’s input is a UsageError; the lens’s limits a LensRefusal', () => {
  const relative = rule({ field: 'createdAt', dateOperator: 'within', value: { this: 'month' } });
  const lens: LensNarrowing = {
    parent: base,
    root: { where: relative, sources: { name: relative } },
  };
  const row = [user(1, 'a', { createdAt: new Date() })];
  test.each([
    ['no now', {}],
    ['an invalid now', { now: 'garbage' }],
    ['an invalid time zone', { now: new Date(), timeZone: 'Not/AZone' }],
  ])('%s', (_, options) => {
    for (const run of [
      () => toPrisma(true, { lens, ...options }),
      () => toSql(rule({ field: 'name', operator: 'exists' }), { lens, ...options }),
      () => toSourceQueries(lens, options),
      () => materializeSources(lens, row, options),
    ])
      expect(thrown(run)).toBeInstanceOf(UsageError);
  });

  test('a bind never bound, in materializeSources', () => {
    const bound: LensNarrowing = {
      parent: base,
      root: { sources: { name: rule({ field: 'age', operator: 'lessThan', bind: 'max' }) } },
    };
    expect(thrown(() => materializeSources(bound, row))).toBeInstanceOf(UsageError);
  });

  test('both classes say their name', () => {
    expect(new UsageError('x').name).toBe('UsageError');
    expect(new LensRefusal('x', 'c').name).toBe('LensRefusal');
  });
});

describe('R11-F4: a lens clamp a compile can’t hold refuses the rule, never a plain Error', () => {
  test.each([
    [
      'a window re-rooted under a to-one hop',
      {
        relations: {
          org: {
            where: rule({
              field: 'users',
              arrayOperator: 'any',
              orderBy: [{ field: 'id', dir: 'desc' }],
              take: 1,
              condition: { field: 'age', operator: 'greaterThan', value: 35 },
            }),
            relations: { users: {} },
          },
        },
      },
      rule({ field: 'org.name', operator: 'exists' }),
    ],
    [
      'a nested scope ref re-rooted under a to-one hop',
      {
        relations: {
          org: {
            where: rule({
              field: 'users',
              arrayOperator: 'any',
              condition: {
                field: 'posts',
                arrayOperator: 'any',
                condition: { field: 'views', operator: 'greaterThan', path: '$$.age' },
              },
            }),
            relations: { users: {} },
          },
        },
      },
      rule({ field: 'org.name', operator: 'exists' }),
    ],
    [
      'a window in the root clamp',
      {
        where: rule({
          field: 'posts',
          arrayOperator: 'any',
          orderBy: [{ field: 'id', dir: 'desc' }],
          take: 1,
          condition: { field: 'views', operator: 'greaterThan', value: 3 },
        }),
        relations: { posts: {} },
      },
      true as Condition,
    ],
  ])('%s', (_, root, r) => {
    const lens = { parent: base, root } as LensNarrowing;
    expect(thrown(() => toPrisma(r, { lens }))).toBeInstanceOf(LensRefusal);
    // The rule alone compiles: what refuses is the lens.
    expect(thrown(() => toPrisma(r, { map, model: 'User' }))).toBeNull();
  });
});
