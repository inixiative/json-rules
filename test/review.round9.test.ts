import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  bindLens,
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
} from '../index';
import { map, openRails } from './rails/harness';

// The adversarial review of 3.4 (round 9): the source-options pipeline. Each finding's repro,
// failing first.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

const refusal = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    expect((error as Error).constructor.name).toBe('LensRefusal');
    return (error as Error).message;
  }
};

const values = (options: readonly { value: string }[]) => options.map((o) => o.value);

/** A source query run on both database rails, as `materializeSourceQuery` reads them. */
const onRails = async (query: SourceQuery) => {
  const delegates = rails.prisma as unknown as Record<
    string,
    { findMany: (args: object) => Promise<object[]> }
  >;
  if (query.prisma === null) return { prisma: null, sql: null };
  const { model, steps, ...args } = query.prisma;
  const where = steps
    ? await executePrismaPlan({ steps } as never, rails.prisma as never)
    : args.where;
  const prismaRows = await delegates[model.toLowerCase()].findMany({ ...args, where });
  const sqlRows =
    query.sql.sql === null ? null : (await rails.db.query(query.sql.sql, query.sql.params)).rows;
  return {
    prisma: materializeSourceQuery(query, prismaRows as never).options,
    sql: sqlRows && materializeSourceQuery(query, sqlRows as never, { rowShape: 'sql' }).options,
  };
};

const userPosts: FieldMap = {
  models: {
    User: {
      fields: {
        id: s('String'),
        name: s('String'),
        posts: { kind: 'object', type: 'Post', isList: true, relationName: 'UP' },
      },
    },
    Post: {
      fields: {
        id: s('String'),
        title: s('String'),
        tags: { kind: 'scalar', type: 'String', isList: true },
        d: s('DateTime'),
        authorId: s('String'),
        author: {
          kind: 'object',
          type: 'User',
          relationName: 'UP',
          fromFields: ['authorId'],
          toFields: ['id'],
        },
      },
    },
  },
};
const base = createLens({ maps: { app: userPosts }, mapName: 'app', model: 'User' });

describe('R9-A: a grant the fetch or an option query cannot compile is refused by the rule validator', () => {
  test.each([
    ['matches', rule({ field: 'title', operator: 'matches', value: '^a' })],
    [
      'a case-insensitive list comparison',
      rule({ field: 'tags', operator: 'contains', value: 'A', caseInsensitive: true }),
    ],
    ['fuzzy', rule({ field: 'title', operator: 'fuzzy', value: 'abc' })],
  ])('%s on a to-many relation: validation and toLensSelect refuse', (_, where) => {
    const lens: LensNarrowing = { parent: base, root: { relations: { posts: { where } } } };
    expect(validateNarrowing(lens).ok).toBe(false);
    expect(refusal(() => toLensSelect(lens))).toMatch(/toLensSelect: the grant on 'posts'/);
  });

  test('matches in a source where: validation and toSourceQueries refuse', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { sources: { name: rule({ field: 'name', operator: 'matches', value: '^a' }) } },
    };
    expect(validateNarrowing(lens).ok).toBe(false);
    expect(refusal(() => toSourceQueries(lens))).toMatch(/source 'name' at 'User'/);
  });
});

describe('R9-N2: toSourceQueries takes the compilers’ options', () => {
  const lens: LensNarrowing = {
    parent: base,
    root: {
      relations: {
        posts: { where: rule({ field: 'd', dateOperator: 'after', value: { ago: { days: 30 } } }) },
      },
      sources: {
        name: rule({
          field: 'posts',
          arrayOperator: 'any',
          condition: { field: 'title', operator: 'exists' },
        }),
      },
    },
  };

  test('a relative-date grant in a source where compiles with `now`', () => {
    expect(validateNarrowing(lens).ok).toBe(true);
    const [query] = toSourceQueries(lens, { now: new Date('2026-10-08T00:00:00Z') });
    expect(JSON.stringify(query.prisma?.where)).toContain('2026-09-08');
  });

  test('without `now` it is a usage error at runtime, not a refusal', () => {
    expect(() => toSourceQueries(lens)).toThrow(/require `now`/);
    expect(refusal(() => toSourceQueries(lens, { now: new Date() }))).toBeNull();
  });

  test('a bound lens compiles its binds', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: { sources: { name: rule({ field: 'name', operator: 'equals', bind: 'who' }) } },
    };
    const [query] = toSourceQueries(bindLens(lens, { who: 'ann' }), { now: new Date() });
    expect(query.sql.params).toEqual(['ann']);
  });
});

describe('R9-P1: a source where across a bridge has no database form', () => {
  const maps = {
    prisma: {
      models: { FanUser: { fields: { id: s('String'), email: s('String'), crmId: s('String') } } },
    },
    salesforce: {
      models: {
        Contact: { fields: { id: s('String'), industry: s('String'), tenant: s('String') } },
      },
    },
  } as Record<string, FieldMap>;
  const bridges = [
    {
      endpoints: [
        { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
        { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
      ],
      cardinality: 'oneToMany',
    },
  ];
  const bridged = createLens({ maps, bridges, mapName: 'prisma', model: 'FanUser' } as never);
  const rows = [
    {
      id: 'u1',
      email: 'a@x',
      crmId: 'c1',
      'salesforce:Contact': { id: 'c1', industry: 'tech', tenant: 't1' },
    },
    {
      id: 'u2',
      email: 'b@x',
      crmId: 'c2',
      'salesforce:Contact': { id: 'c2', industry: 'tech', tenant: 't2' },
    },
    {
      id: 'u3',
      email: 'c@x',
      crmId: 'c3',
      'salesforce:Contact': { id: 'c3', industry: 'retail', tenant: 't1' },
    },
  ];
  const tenant = {
    salesforce: {
      models: { Contact: { where: rule({ field: 'tenant', operator: 'equals', value: 't1' }) } },
    },
  };

  test.each<[string, LensNarrowing, string[]]>([
    [
      'its own where',
      {
        parent: bridged,
        root: {
          relations: { 'salesforce:Contact': {} },
          sources: {
            email: rule({
              field: 'salesforce:Contact.industry',
              operator: 'equals',
              value: 'tech',
            }),
          },
        },
      },
      ['a@x', 'b@x'],
    ],
    [
      'a grant carried across it',
      {
        parent: bridged,
        root: {
          relations: { 'salesforce:Contact': {} },
          sources: { email: rule({ field: 'salesforce:Contact', operator: 'exists' }) },
        },
        mapDefaults: tenant,
      },
      ['a@x', 'c@x'],
    ],
  ])('%s: neither rail compiles it, and materializeSources offers the right set', (_, lens, expected) => {
    expect(validateNarrowing(lens).ok).toBe(true);
    const [query] = toSourceQueries(lens);
    expect(query.prisma).toBeNull();
    expect(query.sql.sql).toBeNull();
    expect(query.sql.error).toMatch(/across a bridge/);
    expect(values(materializeSources(lens, rows)[0].options)).toEqual(expected);
  });
});

describe('R9-N1/P2: the fetch pipeline offers what the database offers', () => {
  const prismaBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
  const pipeline = async (lens: LensNarrowing) => {
    expect(validateNarrowing(lens).ok).toBe(true);
    const where = await executePrismaPlan(toPrisma(true, { lens }), rails.prisma as never);
    const fetched = (await rails.prisma.user.findMany({
      where: where as never,
      select: toLensSelect(lens).select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];
    const kept = projectRows(lens, fetched, { keepGrantColumns: true });
    const db: string[][] = [];
    for (const query of toSourceQueries(lens)) {
      const { prisma, sql } = await onRails(query);
      expect(sql === null ? prisma : sql).toEqual(prisma);
      db.push(values(prisma ?? []));
    }
    return {
      db,
      fetched: materializeSources(lens, fetched).map((v) => values(v.options)),
      kept: materializeSources(lens, kept).map((v) => values(v.options)),
    };
  };

  test.each<[string, LensNarrowing, string[]]>([
    [
      'a to-one row its grant hides, at the sourced visit',
      {
        parent: prismaBase,
        root: {
          relations: {
            org: {
              where: rule({ field: 'plan', operator: 'equals', value: 'pro' }),
              sources: { name: true },
            },
          },
        },
      },
      ['Acme'],
    ],
    [
      'the sourced column read by the grant',
      {
        parent: prismaBase,
        root: {
          relations: {
            org: {
              where: rule({ field: 'name', operator: 'equals', value: 'Acme' }),
              sources: { name: true },
            },
          },
        },
      },
      ['Acme'],
    ],
    [
      'a root source through a to-one row its grant hides',
      {
        parent: prismaBase,
        root: {
          relations: { org: { where: rule({ field: 'plan', operator: 'equals', value: 'pro' }) } },
          sources: { name: rule({ field: 'org.seats', operator: 'notEquals', value: 0 }) },
        },
      },
      ['Ann', 'Dee', 'nullable'],
    ],
    [
      'a nested source under a root grant, carried by the inverse relation',
      {
        parent: prismaBase,
        root: {
          where: rule({ field: 'age', operator: 'greaterThanEquals', value: 30 }),
          relations: { posts: { sources: { title: true } } },
        },
      },
      ['hello', 'later'],
    ],
    [
      'a root source over a list the lens does not fetch',
      {
        parent: prismaBase,
        root: {
          sources: {
            name: rule({
              field: 'posts',
              arrayOperator: 'none',
              condition: { field: 'views', operator: 'exists' },
            }),
          },
        },
      },
      ['bob', 'Dee', 'nullable'],
    ],
    [
      'a source reading a column the lens hides',
      {
        parent: prismaBase,
        root: {
          picks: ['name'],
          sources: { name: rule({ field: 'age', operator: 'greaterThan', value: 6 }) },
        },
      },
      ['Ann', 'Dee', 'nullable'],
    ],
  ])('%s', async (_, lens, expected) => {
    const { db, fetched, kept } = await pipeline(lens);
    expect(db).toEqual([expected]);
    expect(fetched).toEqual([expected]);
    expect(kept).toEqual([expected]);
  });
});

describe('R9-P3: every rail labels a value the same way', () => {
  test('the least label wins, on every rail', async () => {
    // Ann holds 'hello' (views 10) and 'later' (views null); label each title by its views.
    const prismaBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Post' });
    const lens: LensNarrowing = {
      parent: prismaBase,
      root: { sources: { authorId: { label: 'title' } } },
    };
    const [query] = toSourceQueries(lens);
    const { prisma, sql } = await onRails(query);
    const all = await rails.prisma.post.findMany({ orderBy: { id: 'desc' } });
    const checked = materializeSources(lens, all as never)[0].options;
    expect(prisma).toEqual(checked);
    expect(sql).toEqual(checked);
    expect(checked.find((o) => o.value === '1')?.label).toBe('hello');
  });
});
