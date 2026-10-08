import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  bindLens,
  type Condition,
  createLens,
  describeRule,
  type FieldMap,
  type LensNarrowing,
  lensVisit,
  projectLens,
  projectRows,
  toLensSelect,
  toPrisma,
  toSql,
  validateNarrowing,
  validateRule,
  validateRuleInLens,
} from '../index';
import { mulberry32 } from './fuzz/mulberry32';
import { map, openRails } from './rails/harness';

// The adversarial review of 3.4 (round 7): each finding's repro, failing first.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;
const rel = (t: string, relationName: string, isList = false) =>
  ({ kind: 'object', type: t, isList, relationName }) as const;
const now = new Date('2026-10-08T00:00:00Z');

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

const userPosts: FieldMap = {
  models: {
    User: { fields: { id: s('String'), posts: rel('Post', 'UP', true) } },
    Post: {
      fields: {
        id: s('String'),
        title: s('String'),
        deleted: s('Boolean'),
        author: rel('User', 'UP'),
      },
    },
  },
};
const upBase = createLens({ maps: { app: userPosts }, mapName: 'app', model: 'User' });

describe('R7-1: the validators return a result, never throw', () => {
  const live = rule({ field: 'deleted', operator: 'equals', value: false });
  const flat = rule({ field: 'posts.title', operator: 'equals', value: 'x' });

  test('f1: a rule reading a to-many relation flat through a grant: an issue, not a throw', () => {
    const lens: LensNarrowing = { parent: upBase, root: { relations: { posts: { where: live } } } };
    const result = validateRuleInLens(flat, lens);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toMatch(/to-many/);
    expect(() => toPrisma(flat, { lens })).toThrow();
  });

  test('f9: a later grant reading a to-many relation flat: an issue, not a throw', () => {
    const l1: LensNarrowing = { parent: upBase, root: { relations: { posts: { where: live } } } };
    for (const l2 of [
      { parent: l1, root: { where: flat } },
      { parent: l1, mapDefaults: { app: { models: { User: { where: flat } } } } },
      { parent: l1, root: { sources: { id: flat } } },
    ] as LensNarrowing[])
      expect(validateNarrowing(l2).ok).toBe(false);
  });

  test('fuzz: random lenses and rules never make a validator throw', () => {
    const rnd = mulberry32(5);
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const conditions = (): Condition =>
      pick([
        rule({ field: pick(['title', 'deleted', 'id']), operator: 'exists' }),
        rule({ field: 'posts.title', operator: 'equals', value: 'x' }),
        rule({
          field: 'posts',
          arrayOperator: pick(['any', 'all', 'atLeast']),
          count: 1,
          condition: true,
        }),
        rule({ field: 'author.id', operator: 'exists' }),
        rule({ field: 'id', operator: 'equals', path: pick(['$.id', '$$.id', 'id', '$$$.x']) }),
        rule({
          field: 'posts',
          arrayOperator: 'any',
          condition: { field: 'title', operator: 'equals', path: '$$.id' },
        }),
      ]);
    const node = (depth: number): Record<string, unknown> => ({
      ...(rnd() < 0.4 && { where: conditions() }),
      ...(rnd() < 0.2 && { picks: [pick(['id', 'title'])] }),
      ...(depth > 0 &&
        rnd() < 0.6 && { relations: { [pick(['posts', 'author'])]: node(depth - 1) } }),
    });
    const throwers: string[] = [];
    for (let i = 0; i < 300; i++) {
      const l1 = { parent: upBase, root: node(2) } as LensNarrowing;
      const l2 = {
        parent: l1,
        root: node(1),
        mapDefaults: { app: { models: { Post: { where: conditions() } } } },
      } as LensNarrowing;
      for (const lens of [l1, l2]) {
        try {
          validateNarrowing(lens);
          validateRuleInLens(conditions(), lens);
        } catch (error) {
          throwers.push(`${i}: ${(error as Error).message}`);
        }
      }
    }
    expect(throwers.slice(0, 5)).toEqual([]);
  });
});

describe('R7-2: off-tree visits are found from the grants themselves, bound or not', () => {
  const schema: FieldMap = {
    models: {
      User: {
        fields: { id: s('String'), posts: rel('Post', 'UP', true), org: rel('Org', 'UO') },
      },
      Post: {
        fields: {
          id: s('String'),
          ownerId: s('String'),
          createdAt: s('DateTime'),
          author: rel('User', 'UP'),
        },
      },
      Org: { fields: { id: s('String'), plan: s('String'), users: rel('User', 'UO', true) } },
    },
  };
  const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'User' });
  const mk = (postsWhere: Condition | null) => {
    const l1: LensNarrowing = {
      parent: base,
      root: {
        where: rule({ field: 'org.id', operator: 'exists' }),
        relations: { posts: postsWhere ? { where: postsWhere } : {} },
      },
      mapDefaults: { app: { models: { Org: { picks: ['id'] } } } },
    };
    const l2: LensNarrowing = {
      parent: l1,
      mapDefaults: {
        app: {
          models: { Org: { where: rule({ field: 'plan', operator: 'equals', value: 'pro' }) } },
        },
      },
    };
    return { l1, l2 };
  };

  test.each<[string, Condition | null]>([
    ['no other grant', null],
    [
      'a relative-date grant',
      rule({ field: 'createdAt', dateOperator: 'after', value: { ago: { days: 30 } } }),
    ],
    ['a bind grant', rule({ field: 'ownerId', operator: 'equals', bind: 'viewer' })],
  ])('%s: validateNarrowing refuses the later grant the bound runtime refuses', (_, postsWhere) => {
    const { l1, l2 } = mk(postsWhere);
    expect(validateNarrowing(l1).ok).toBe(true);
    expect(validateNarrowing(l2).ok).toBe(false);
    const bound = bindLens(l2, { viewer: 'u1' });
    expect(() => toLensSelect(bound, { now })).toThrow(/parent does not show/);
  });
});

describe('R7-3: a later grant that never applies is not refused', () => {
  const schema: FieldMap = {
    models: {
      User: { fields: { id: s('String'), name: s('String'), org: rel('Org', 'UO') } },
      Org: { fields: { id: s('String'), plan: s('String'), users: rel('User', 'UO', true) } },
    },
  };
  const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'User' });
  const l1: LensNarrowing = {
    parent: base,
    root: { relations: { org: {} } },
    mapDefaults: { app: { models: { Org: { picks: ['id'] } } } },
  };
  const grant = rule({ field: 'plan', operator: 'equals', value: 'pro' });

  test('the same layer omits org and restates it with a grant on a hidden column', () => {
    const l2: LensNarrowing = {
      parent: l1,
      root: { omits: ['org'], relations: { org: { where: grant } } },
    };
    expect(validateNarrowing(l2).ok).toBe(true);
    expect(() => toLensSelect(l2)).not.toThrow();
  });
});

describe('R7-4: a root that shows no column is fetched by its key', () => {
  test('picks: [] at the root selects the id, re-checks, and a viewer never sees it', async () => {
    const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
    const lens: LensNarrowing = { parent: base, root: { picks: [], relations: { posts: {} } } };
    const select = toLensSelect(lens).select;
    expect(select.id).toBe(true);
    const rows = (await rails.prisma.user.findMany({
      select: select as never,
      orderBy: { id: 'asc' },
    })) as Record<string, unknown>[];
    expect(rows.length).toBe(5);
    expect(projectRows(lens, rows).every((row) => !Object.hasOwn(row, 'id'))).toBe(true);
  });
});

describe('R7-5: supportedTargets matches what toSql compiles for a column ref', () => {
  const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
  const lens: LensNarrowing = { parent: base, root: { relations: { org: {} } } };
  test.each([
    ['name', 'contains', 'org.name'],
    ['name', 'startsWith', 'name'],
    ['name', 'notEndsWith', '$.name'],
    ['name', 'in', '$.name'],
    ['age', 'notIn', 'score'],
    ['age', 'contains', 'score'],
    ['name', 'matches', 'name'],
  ])('%s %s %s: refused on toSql, and said so', (field, operator, path) => {
    const r = rule({ field, operator, path });
    expect(() => toSql(r, { map, model: 'User' })).toThrow();
    expect(validateRule(r, { target: 'toSql', map, model: 'User' }).ok).toBe(false);
    expect(describeRule(r, lens).supportedTargets).not.toContain('toSql');
  });
});

describe('PERF: walking one visit at a time stays cheap', () => {
  // Spelled-heavy: every path four deep spelled, plus the defaults on every model.
  const names = ['A', 'B', 'C', 'D'];
  const schema: FieldMap = { models: {} };
  for (const n of names) {
    const fields: FieldMap['models'][string]['fields'] = { id: s('String'), x: s('String') };
    for (const t of names) if (t !== n) fields[t.toLowerCase()] = rel(t, `${n}${t}`);
    schema.models[n] = { fields };
  }
  const spell = (model: string, depth: number): Record<string, unknown> =>
    depth === 0
      ? {}
      : {
          relations: Object.fromEntries(
            names.filter((t) => t !== model).map((t) => [t.toLowerCase(), spell(t, depth - 1)]),
          ),
        };
  const lens: LensNarrowing = {
    parent: createLens({ maps: { app: schema }, mapName: 'app', model: 'A' }),
    root: spell('A', 4) as never,
    mapDefaults: {
      app: {
        models: Object.fromEntries(
          names.map((n) => [
            n,
            {
              relations: Object.fromEntries(
                names.filter((t) => t !== n).map((t) => [t.toLowerCase(), {}]),
              ),
            },
          ]),
        ),
      },
    },
  };
  const later: LensNarrowing = {
    parent: lens,
    mapDefaults: { app: { models: { B: { where: rule({ field: 'x', operator: 'exists' }) } } } },
  };

  test('lensVisit over every projected path, and validateNarrowing, stay fast', () => {
    const paths = Object.keys(projectLens(later)).map((k) => k.split('.').slice(1).join('.'));
    expect(paths.length).toBeGreaterThan(100);
    const start = performance.now();
    for (const p of paths) lensVisit(later, p);
    expect(performance.now() - start).toBeLessThan(1500);
    const v = performance.now();
    validateNarrowing(later);
    expect(performance.now() - v).toBeLessThan(500);
  });
});
