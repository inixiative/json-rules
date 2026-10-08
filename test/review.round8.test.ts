import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  type FieldMap,
  type LensNarrowing,
  lensVisit,
  materializeSourceQuery,
  materializeSources,
  projectLens,
  projectRows,
  type SourceQuery,
  toLensSelect,
  toSourceQueries,
  validateNarrowing,
} from '../index';
import { map, openRails } from './rails/harness';

// The adversarial review of 3.4 (round 8): each finding's repro, failing first.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;
const rel = (t: string, relationName: string, isList = false, fk?: [string, string]) =>
  ({
    kind: 'object',
    type: t,
    isList,
    relationName,
    ...(fk && { fromFields: [fk[0]], toFields: [fk[1]] }),
  }) as const;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

/** The first refusal any runtime posture makes over a lens, or null: every posture a narrowing's
 *  validity promises — projection both ways, a visit at each shown path, the source plans and the
 *  fetch. A throw that is not a refusal fails the test. */
const refusedBy = (lens: LensNarrowing, rows?: Record<string, unknown>[]): string | null => {
  const attempts: [string, () => unknown][] = [
    ['projectLens', () => projectLens(lens)],
    ['projectLens by model', () => projectLens(lens, { by: 'model' })],
    ['toSourceQueries', () => toSourceQueries(lens)],
    // A fetched collection can't hold a model source's rows: materialized only from given rows.
    ...(rows
      ? [['materializeSources', () => materializeSources(lens, rows)] as [string, () => unknown]]
      : []),
    ['toLensSelect', () => toLensSelect(lens)],
    ['projectRows', () => projectRows(lens, rows ?? [], { keepClampColumns: true })],
  ];
  for (const [name, attempt] of attempts) {
    try {
      attempt();
    } catch (error) {
      expect((error as Error).constructor.name).toBe('LensRefusal');
      return `${name}: ${(error as Error).message}`;
    }
  }
  return null;
};

const userPosts: FieldMap = {
  models: {
    User: {
      fields: {
        id: s('String'),
        name: s('String'),
        nick: s('String'),
        orgId: s('String'),
        org: rel('Org', 'UO', false, ['orgId', 'id']),
        posts: rel('Post', 'UP', true),
      },
    },
    Post: {
      fields: {
        id: s('String'),
        title: s('String'),
        secret: s('String'),
        deleted: s('Boolean'),
        authorId: s('String'),
        author: rel('User', 'UP', false, ['authorId', 'id']),
      },
    },
    Org: { fields: { id: s('String'), plan: s('String'), users: rel('User', 'UO', true) } },
  },
};
const base = createLens({ maps: { app: userPosts }, mapName: 'app', model: 'User' });

describe('R8-1: validateNarrowing runs the postures the runtime runs', () => {
  test('a: a pointer reads its model at the model-intrinsic visit, where the clamp reads a relation the parent turns on only along the path', () => {
    const l1: LensNarrowing = {
      parent: base,
      root: {
        relations: {
          posts: { relations: { author: {} }, sources: { title: { from: 'mapDefaults' } } },
        },
      },
      mapDefaults: {
        app: {
          models: {
            Post: { sources: { title: { where: rule({ field: 'title', operator: 'exists' }) } } },
          },
        },
      },
    };
    const l2: LensNarrowing = {
      parent: l1,
      mapDefaults: {
        app: { models: { Post: { where: rule({ field: 'author.id', operator: 'exists' }) } } },
      },
    };
    expect(validateNarrowing(l1).ok).toBe(true);
    expect(refusedBy(l1)).toBeNull();
    const v = validateNarrowing(l2);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message).join()).toMatch(/does not show: 'author.id'/);
    expect(refusedBy(l2)).toMatch(/does not show: 'author.id'/);
    expect(() => lensVisit(l2, 'posts')).toThrow(/does not show: 'author.id'/);
  });

  // A list clamp re-roots under a to-one hop (round 10); one whose inner ref reads the row being
  // re-rooted (`$$.` inside `users any`) can't.
  test('d: a source path crossing a to-one relation whose clamp narrowRule cannot re-root', () => {
    const l1: LensNarrowing = {
      parent: base,
      root: { sources: { name: rule({ field: 'org.id', operator: 'exists' }) } },
      mapDefaults: {
        app: {
          models: {
            Org: {
              where: rule({
                field: 'users',
                arrayOperator: 'any',
                condition: { field: 'id', operator: 'equals', path: '$$.id' },
              }),
            },
          },
        },
      },
    };
    const v = validateNarrowing(l1);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message).join()).toMatch(/cannot re-root/);
    expect(refusedBy(l1)).toMatch(/^toSourceQueries: .*cannot re-root/);
  });

  // A later clamp on a column the parent hides, met where a source reads the relation's rows: the
  // source now carries the clamp (R8-3), so the clamp applies there, and both refuse it. Where the
  // parent shows the column, both accept, and the options carry the clamp.
  test.each([
    ['the parent hides the column the clamp reads', true],
    ['the parent shows it', false],
  ])('b: %s — validation and the runtime agree', (_, hidden) => {
    const l1: LensNarrowing = {
      parent: base,
      root: {
        sources: {
          name: rule({
            field: 'posts',
            arrayOperator: 'any',
            condition: { field: 'title', operator: 'exists' },
          }),
        },
      },
      ...(hidden && { mapDefaults: { app: { models: { Post: { omits: ['secret'] } } } } }),
    };
    const l2: LensNarrowing = {
      parent: l1,
      mapDefaults: {
        app: {
          models: { Post: { where: rule({ field: 'secret', operator: 'equals', value: 'x' }) } },
        },
      },
    };
    expect(validateNarrowing(l1).ok).toBe(true);
    const v = validateNarrowing(l2);
    const refused = refusedBy(l2);
    expect(v.ok).toBe(refused === null);
    expect(v.ok).toBe(!hidden);
    if (hidden) return;
    const rows = [
      { id: 'u1', name: 'alice', posts: [{ id: 'p', title: 't', secret: 'y' }] },
      { id: 'u2', name: 'bob', posts: [{ id: 'q', title: 't', secret: 'x' }] },
    ];
    expect(materializeSources(l2, rows)[0].options).toEqual([{ value: 'bob' }]);
  });
});

describe('R8-2: a later clamp reads through every layer above it, the source declaring layer included', () => {
  test('f: a label declared by the first narrowing, a later clamp crossing the relation it turns on', () => {
    const l1: LensNarrowing = {
      parent: base,
      root: { relations: { org: {} }, sources: { name: { label: 'nick' } } },
    };
    const l2: LensNarrowing = { parent: l1, root: { omits: ['orgId'] } };
    const l3: LensNarrowing = {
      parent: l2,
      root: { where: rule({ field: 'org.plan', operator: 'equals', value: 'pro' }) },
    };
    for (const lens of [l1, l2, l3]) {
      expect(validateNarrowing(lens).ok).toBe(true);
      expect(refusedBy(lens)).toBeNull();
    }
    expect(lensVisit(l3, '')?.sourceLabels).toEqual({ name: 'nick' });
  });
});

describe('R8-3: a source where narrows like a rule: options never come through rows the lens hides', () => {
  const live = rule({ field: 'deleted', operator: 'equals', value: false });
  const offered = (where: Condition, clamp: Condition = live) => {
    const lens: LensNarrowing = {
      parent: base,
      root: { relations: { posts: {} }, sources: { name: where } },
      mapDefaults: { app: { models: { Post: { where: clamp } } } },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    const rows = [
      { id: 'u1', name: 'alice', posts: [{ id: 'p1', title: 'secret-project', deleted: true }] },
      { id: 'u2', name: 'bob', posts: [{ id: 'p2', title: 'secret-project', deleted: false }] },
    ];
    return materializeSources(lens, rows)[0].options.map((o) => o.value);
  };

  test('c: inside an array condition', () => {
    const where = rule({
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'title', operator: 'equals', value: 'secret-project' },
    });
    expect(offered(where)).toEqual(['bob']);
  });

  test('inside an array condition with no condition of its own (a count of the shown rows)', () => {
    expect(offered(rule({ field: 'posts', arrayOperator: 'notEmpty' }))).toEqual(['bob']);
  });

  test('on the terminal relation of a dotted path, and a hop of one', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        relations: { org: {} },
        sources: { name: rule({ field: 'org', operator: 'exists' }) },
      },
      mapDefaults: {
        app: {
          models: { Org: { where: rule({ field: 'plan', operator: 'equals', value: 'pro' }) } },
        },
      },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    const rows = [
      { id: 'u1', name: 'alice', org: { id: 'o1', plan: 'free' } },
      { id: 'u2', name: 'bob', org: { id: 'o2', plan: 'pro' } },
    ];
    expect(materializeSources(lens, rows)[0].options).toEqual([{ value: 'bob' }]);
    const [query] = toSourceQueries(lens);
    expect(JSON.stringify(query.composedWhere)).toContain('"org.plan"');
  });

  test('the database rails offer what materializeSources offers', async () => {
    const prismaBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const viaRails = async (query: SourceQuery) => {
      const delegates = rails.prisma as unknown as Record<
        string,
        { findMany: (args: object) => Promise<object[]> }
      >;
      if (query.prisma === null) throw new Error('no query');
      const { model, steps: _steps, ...args } = query.prisma;
      const prismaRows = await delegates[model.toLowerCase()].findMany(args);
      // SQL has no form for a relation array: the query says so, and Prisma runs it.
      const sqlRows =
        query.sql.sql === null
          ? null
          : (await rails.db.query(query.sql.sql, query.sql.params)).rows;
      return {
        prisma: materializeSourceQuery(query, prismaRows as never).options,
        sql:
          sqlRows && materializeSourceQuery(query, sqlRows as never, { rowShape: 'sql' }).options,
      };
    };
    const posts = (title: string) =>
      rule({
        field: 'posts',
        arrayOperator: 'any',
        condition: { field: 'title', operator: 'equals', value: title },
      });
    const views = rule({ field: 'views', operator: 'greaterThan', value: 6 });
    const plan = rule({ field: 'org.plan', operator: 'equals', value: 'pro' });
    const seats = (n: number) => rule({ field: 'seats', operator: 'greaterThan', value: n });
    // Ann's 'later' post has no views and her 'hello' post 10; her org, the one 'pro' org, 5 seats.
    for (const [where, model, clamp, expected, sql] of [
      [posts('later'), 'Post', views, [], false],
      [posts('hello'), 'Post', views, [{ value: 'Ann' }], false],
      [plan, 'Org', seats(5), [], true],
      [plan, 'Org', seats(4), [{ value: 'Ann' }], true],
    ] as const) {
      const lens: LensNarrowing = {
        parent: prismaBase,
        root: { sources: { name: where } },
        mapDefaults: { prisma: { models: { [model]: { where: clamp } } } },
      };
      expect(validateNarrowing(lens).ok).toBe(true);
      const [query] = toSourceQueries(lens);
      const checked = materializeSources(lens, rails.rows as never)[0].options;
      expect({ check: checked, ...(await viaRails(query)) }).toEqual({
        check: [...expected],
        prisma: [...expected],
        sql: sql ? [...expected] : null,
      });
    }
  });
});

describe('R8-4: refusals the planners make are lens refusals, and validation reports them', () => {
  const liveDefaults = {
    app: {
      models: { Post: { where: rule({ field: 'deleted', operator: 'equals', value: false }) } },
    },
  };

  test('e: a source where reading a clamped to-many relation flat', () => {
    const lens: LensNarrowing = {
      parent: base,
      root: {
        relations: { posts: {} },
        sources: { name: rule({ field: 'posts.title', operator: 'exists' }) },
      },
      mapDefaults: liveDefaults,
    };
    expect(validateNarrowing(lens).ok).toBe(false);
    expect(refusedBy(lens)).toMatch(/^toSourceQueries: .*to-many relation clamp on 'posts'/);
  });

  test('k: a to-many relation whose clamp has a window the fetch select cannot compile', () => {
    const windowed: LensNarrowing = {
      parent: createLens({ maps: { app: windowSchema }, mapName: 'app', model: 'User' }),
      root: { relations: { posts: {} } },
      mapDefaults: {
        app: {
          models: {
            Post: {
              where: rule({
                field: 'comments',
                arrayOperator: 'all',
                condition: { field: 'ok', operator: 'equals', value: true },
                orderBy: [{ field: 'at', dir: 'desc' }],
                take: 1,
              }),
            },
          },
        },
      },
    };
    const v = validateNarrowing(windowed);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message).join()).toMatch(/Windowing/);
    expect(refusedBy(windowed)).toMatch(/^toLensSelect: .*Windowing/);
  });

  test('a to-many relation whose clamp needs a counting step', () => {
    const counted: LensNarrowing = {
      parent: createLens({ maps: { app: windowSchema }, mapName: 'app', model: 'User' }),
      root: { relations: { posts: {} } },
      mapDefaults: {
        app: {
          models: {
            Post: {
              where: rule({
                field: 'comments',
                arrayOperator: 'atLeast',
                count: 2,
                condition: { field: 'ok', operator: 'equals', value: true },
              }),
            },
          },
        },
      },
    };
    expect(validateNarrowing(counted).ok).toBe(false);
    expect(refusedBy(counted)).toMatch(/^toLensSelect: .*counting step/);
  });
});

const windowSchema: FieldMap = {
  models: {
    User: { fields: { id: s('String'), posts: rel('Post', 'UP', true) } },
    Post: {
      fields: {
        id: s('String'),
        authorId: s('String'),
        author: rel('User', 'UP', false, ['authorId', 'id']),
        comments: rel('Comment', 'PC', true),
      },
    },
    Comment: {
      fields: {
        id: s('String'),
        at: s('DateTime'),
        ok: s('Boolean'),
        postId: s('String'),
        post: rel('Post', 'PC', false, ['postId', 'id']),
      },
    },
  },
};

describe('R8-5: the default-tree cache keys on the base lens a narrowing stands on', () => {
  const o = (t: string) => rel(t, t);
  const schema: FieldMap = {
    models: {
      U: { fields: { id: s('String'), a: o('P'), b: o('Q') } },
      V: { fields: { id: s('String'), a: o('P') } },
      P: { fields: { id: s('String'), q: o('Q') } },
      Q: { fields: { id: s('String'), secret: s('String') } },
    },
  };
  const defaults = () => ({
    app: {
      models: {
        U: { relations: { a: {}, b: {} } },
        V: { relations: { a: {} } },
        P: { relations: { q: {} } },
      },
    },
  });

  test('h: a narrowing re-parented in place reads its new base, as a fresh one does', () => {
    const onV = createLens({ maps: { app: schema }, mapName: 'app', model: 'V' });
    const onU = createLens({ maps: { app: schema }, mapName: 'app', model: 'U' });
    const moved: LensNarrowing = { parent: onV, mapDefaults: defaults() };
    expect(Object.keys(projectLens(moved))).toEqual(['V', 'V.a', 'V.a.q']);
    moved.parent = onU;
    const fresh: LensNarrowing = { parent: onU, mapDefaults: defaults() };
    expect(Object.keys(projectLens(moved))).toEqual(Object.keys(projectLens(fresh)));
    expect(Object.keys(projectLens(moved))).toEqual(['U', 'U.a', 'U.b']);
  });
});

describe('R8-6: a malformed source is an issue, never a throw', () => {
  test.each([
    ['on the root', { root: { sources: { name: {} } } }],
    [
      'on a model default',
      { mapDefaults: { app: { models: { User: { sources: { name: {} } } } } } },
    ],
  ])('an empty source %s', (_, layer) => {
    const lens = { parent: base, ...layer } as unknown as LensNarrowing;
    const v = validateNarrowing(lens);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.code)).toEqual(['invalid_source']);
    expect(v.errors[0].path).toMatch(/sources\.name$/);
    expect(refusedBy(lens)).toMatch(/is not a Condition/);
  });
});

describe('R8-7: a source the option query cannot compile is refused by its shape', () => {
  const windowBase = createLens({ maps: { app: windowSchema }, mapName: 'app', model: 'User' });
  const latestOk = rule({
    field: 'comments',
    arrayOperator: 'all',
    condition: { field: 'ok', operator: 'equals', value: true },
    orderBy: [{ field: 'at', dir: 'desc' }],
    take: 1,
  });
  const anyPost = rule({
    field: 'posts',
    arrayOperator: 'any',
    condition: { field: 'id', operator: 'exists' },
  });

  test.each<[string, LensNarrowing]>([
    [
      'a windowed clamp carried into the source where',
      {
        parent: windowBase,
        root: { sources: { id: anyPost } },
        mapDefaults: { app: { models: { Post: { where: latestOk } } } },
      },
    ],
    [
      'a windowed source where of its own',
      {
        parent: windowBase,
        root: { relations: { posts: {} } },
        mapDefaults: { app: { models: { Post: { sources: { id: latestOk } } } } },
      },
    ],
  ])('%s: validation and the runtime both refuse', (_, lens) => {
    const v = validateNarrowing(lens);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message).join()).toMatch(/Windowing/);
    expect(refusedBy(lens)).toMatch(/^toSourceQueries: .*Windowing/);
  });

  test('a counting clamp in a source where compiles (the option query runs its steps)', () => {
    const lens: LensNarrowing = {
      parent: windowBase,
      root: { sources: { id: anyPost } },
      mapDefaults: {
        app: {
          models: {
            Post: {
              where: rule({
                field: 'comments',
                arrayOperator: 'atLeast',
                count: 1,
                condition: { field: 'ok', operator: 'equals', value: true },
              }),
            },
          },
        },
      },
    };
    expect(validateNarrowing(lens).ok).toBe(true);
    expect(toSourceQueries(lens)[0].prisma?.steps?.length).toBeGreaterThan(1);
  });
});
