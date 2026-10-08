import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { isDeepStrictEqual } from 'node:util';
import {
  type Condition,
  createLens,
  describeRule,
  describeRuleSources,
  type FieldMap,
  type LensNarrowing,
  lensVisit,
  narrowRule,
  projectLens,
  projectRows,
  readLensValue,
  toLensSelect,
  toPrisma,
  toSourceQueries,
  toSql,
  validateNarrowing,
  validateRule,
  validateRuleInLens,
  walkLensPath,
} from '../index';
import { mulberry32 } from './fuzz/mulberry32';
import { agree, map, NOW, openRails } from './rails/harness';

// The adversarial review of 3.4 (round 5): each finding's repro, failing first.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;
const o = (t: string, isList = false) => ({ kind: 'object', type: t, isList }) as const;

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails(
    `INSERT INTO users (id, tags) VALUES (6, '{}'); INSERT INTO posts (id, "authorId", views, title) VALUES (104, 6, NULL, NULL), (105, 4, 4, 'x');`,
  );
});
afterAll(async () => {
  await rails.close();
});

describe('F1/F2: model defaults expose a tree — each model once, at its nearest reach', () => {
  const abcd: FieldMap = {
    models: {
      A: { fields: { id: s('String'), b: o('B'), d: o('D') } },
      D: { fields: { id: s('String'), b: o('B') } },
      B: { fields: { id: s('String'), c: o('C') } },
      C: { fields: { id: s('String'), x: s('String'), y: s('String'), e: o('E') } },
      E: { fields: { id: s('String'), z: s('String') } },
    },
  };
  const base = createLens({ maps: { app: abcd }, mapName: 'app', model: 'A' });
  const row = {
    id: '1',
    b: { id: 'b', c: { id: 'c', x: 'X', y: 'Y' } },
    d: { id: 'd', b: { id: 'b2', c: { id: 'c2', x: 'X2', y: 'Y2' } } },
  };

  // Every posture answers one path the same way.
  const postures = (lens: LensNarrowing, path: string, open: boolean) => {
    const leaf = rule({ field: path, operator: 'exists' });
    expect(validateRuleInLens(leaf, lens).ok).toBe(open);
    expect(walkLensPath(lens, path).outcome === 'resolved').toBe(open);
    const relations = path.split('.').slice(0, -1).join('.');
    expect(
      lensVisit(lens, relations) !== null &&
        Object.hasOwn(lensVisit(lens, relations)?.fields ?? {}, path.split('.').at(-1) ?? ''),
    ).toBe(open);
    expect(Object.hasOwn(projectLens(lens), ['A', ...path.split('.').slice(0, -1)].join('.'))).toBe(
      lensVisit(lens, relations) !== null,
    );
    const read = readLensValue(lens, row, path);
    expect(read.ok || read.reason !== 'hidden').toBe(open);
  };

  test('p1: B is reached once, by A.b (one hop); A.d.b is not in the tree', () => {
    const n1: LensNarrowing = {
      parent: base,
      mapDefaults: {
        app: {
          models: {
            A: { relations: { b: { relations: { c: { picks: ['x'] } } }, d: {} } },
            D: { relations: { b: {} } },
            B: { relations: { c: {} } },
          },
        },
      },
    };
    expect(validateNarrowing(n1).ok).toBe(true);
    expect(Object.keys(projectLens(n1)).sort()).toEqual(['A', 'A.b', 'A.b.c', 'A.d']);
    postures(n1, 'b.c.x', true);
    postures(n1, 'b.c.y', false); // the nested relation object picks x along A.b.c
    postures(n1, 'd.b.c.y', false);
    expect(Object.keys(toLensSelect(n1).select.d as object)).toEqual(['select']);
    expect(Object.keys((toLensSelect(n1).select.d as { select: object }).select)).toEqual(['id']);
    expect(projectRows(n1, [row])[0].d).toEqual({ id: 'd' });
  });

  test('p2a: an omit on the tree edge hides E everywhere it would be reached', () => {
    const n2: LensNarrowing = {
      parent: base,
      mapDefaults: {
        app: {
          models: {
            A: { relations: { b: { relations: { c: { omits: ['e'] } } }, d: {} } },
            D: { relations: { b: {} } },
            B: { relations: { c: {} } },
            C: { relations: { e: {} } },
          },
        },
      },
    };
    expect(Object.keys(projectLens(n2, { by: 'model' }).maps.app.models).sort()).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
    postures(n2, 'b.c.e.z', false);
    postures(n2, 'd.b.c.e.z', false);
  });

  test('p2b: validateNarrowing and the runtime agree on a later grant', () => {
    const l1: LensNarrowing = {
      parent: base,
      mapDefaults: {
        app: {
          models: {
            A: {
              relations: { b: {}, d: { relations: { b: { relations: { c: { omits: ['e'] } } } } } },
            },
            D: { relations: { b: {} } },
            B: { relations: { c: {} } },
            C: { relations: { e: {} } },
          },
        },
      },
    };
    const l2: LensNarrowing = {
      parent: l1,
      mapDefaults: {
        app: { models: { C: { where: rule({ field: 'e.z', operator: 'equals', value: 't1' }) } } },
      },
    };
    const valid = validateNarrowing(l2).ok;
    const runs = (() => {
      try {
        toLensSelect(l2);
        toPrisma(rule({ field: 'b.c.x', operator: 'equals', value: 'v' }), { lens: l2 });
        return true;
      } catch {
        return false;
      }
    })();
    expect(runs).toBe(valid);
  });

  test('p2c: each spelled node grows its own default subtree; sources follow it', () => {
    const n3: LensNarrowing = {
      parent: base,
      // The map is one-sided: a grant on d couldn't be carried down to the sources below it.
      root: { relations: { d: {} } },
      mapDefaults: {
        app: {
          models: {
            A: { relations: { b: {} } },
            D: { relations: { b: {} } },
            B: { relations: { c: {} } },
            C: { sources: { y: true } },
          },
        },
      },
    };
    const paths = Object.keys(projectLens(n3)).sort();
    expect(paths).toEqual(['A', 'A.b', 'A.b.c', 'A.d', 'A.d.b', 'A.d.b.c']);
    expect(
      toSourceQueries(n3)
        .map((q) => q.path)
        .sort(),
    ).toEqual(['A.b.c', 'A.d.b.c']);
    expect(lensVisit(n3, 'd.b.c')?.sources).toHaveProperty('y');
    expect(
      describeRuleSources(rule({ field: 'd.b.c.y', operator: 'equals', value: 'v' }), n3).map(
        (d) => d.path,
      ),
    ).toEqual(['A.d.b.c']);
  });

  test('ties go to field declaration order; spell a path to reach a model another way', () => {
    const tie: FieldMap = {
      models: {
        A: { fields: { id: s('String'), p: o('P'), q: o('Q') } },
        P: { fields: { id: s('String'), t: o('T') } },
        Q: { fields: { id: s('String'), t: o('T') } },
        T: { fields: { id: s('String') } },
      },
    };
    const tieBase = createLens({ maps: { app: tie }, mapName: 'app', model: 'A' });
    const on: LensNarrowing = {
      parent: tieBase,
      mapDefaults: {
        app: {
          models: {
            A: { relations: { p: {}, q: {} } },
            P: { relations: { t: {} } },
            Q: { relations: { t: {} } },
          },
        },
      },
    };
    expect(walkLensPath(on, 'p.t.id').outcome).toBe('resolved');
    expect(walkLensPath(on, 'q.t.id')).toMatchObject({ outcome: 'hidden', index: 1 });
    const spelled: LensNarrowing = { ...on, root: { relations: { q: { relations: { t: {} } } } } };
    expect(walkLensPath(spelled, 'q.t.id').outcome).toBe('resolved');
    expect(walkLensPath(spelled, 'p.t.id').outcome).toBe('resolved');
  });

  // A schema whose models relate at random, every relation turned on at the defaults.
  const randomSchema = (models: number, perModel: number, seed: number): LensNarrowing => {
    const rnd = mulberry32(seed);
    const schema: FieldMap = { models: {} };
    const defaults: Record<string, { relations: Record<string, object> }> = {};
    for (let i = 0; i < models; i++) {
      const fields: FieldMap['models'][string]['fields'] = { id: s('String') };
      const relations: Record<string, object> = {};
      for (let k = 0; k < perModel; k++) {
        let to = Math.floor(rnd() * models);
        if (to === i) to = (to + 1) % models;
        fields[`r${k}`] = o(`M${to}`, k % 2 === 0);
        relations[`r${k}`] = {};
      }
      schema.models[`M${i}`] = { fields };
      defaults[`M${i}`] = { relations };
    }
    const lens = createLens({ maps: { app: schema }, mapName: 'app', model: 'M0' });
    return { parent: lens, mapDefaults: { app: { models: defaults } } };
  };

  test.each([
    ['20 models x 4 relations', randomSchema(20, 4, 7)],
    ['30 models x 3 relations', randomSchema(30, 3, 7)],
  ])('%s, all on: every API stays under 200 ms', (_, lens) => {
    const timed = (run: () => unknown) => {
      const start = performance.now();
      run();
      expect(performance.now() - start).toBeLessThan(200);
    };
    timed(() => projectLens(lens));
    timed(() => projectLens(lens, { by: 'model' }));
    timed(() => toLensSelect(lens));
    timed(() => validateNarrowing(lens));
    timed(() => toSourceQueries(lens));
  });

  test('fuzz: every posture agrees on every path of random lenses', () => {
    const names = ['A', 'B', 'C', 'D'];
    const rels: Record<string, [string, string, boolean][]> = {
      A: [
        ['b', 'B', false],
        ['c', 'C', true],
        ['d', 'D', false],
      ],
      B: [
        ['a', 'A', true],
        ['c', 'C', false],
        ['d', 'D', true],
      ],
      C: [
        ['a', 'A', false],
        ['b', 'B', true],
        ['d', 'D', false],
      ],
      D: [
        ['a', 'A', true],
        ['b', 'B', false],
        ['c', 'C', true],
      ],
    };
    const schema: FieldMap = { models: {} };
    for (const n of names) {
      const fields: FieldMap['models'][string]['fields'] = {
        id: s('String'),
        x: s('String'),
        y: s('String'),
      };
      for (const [r, t, l] of rels[n]) fields[r] = o(t, l);
      schema.models[n] = { fields };
    }
    const fuzzBase = createLens({ maps: { app: schema }, mapName: 'app', model: 'A' });
    const rnd = mulberry32(1);
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    type Node = { picks?: string[]; omits?: string[]; relations?: Record<string, Node> };
    const randNode = (model: string, depth: number): Node => {
      const node: Node = {};
      if (rnd() < 0.3) node.picks = [pick(['x', 'y'])];
      if (rnd() < 0.2) node.omits = [pick(rels[model])[0]];
      if (depth > 0 && rnd() < 0.6) {
        node.relations = {};
        for (const [r, t] of rels[model])
          if (rnd() < 0.5) node.relations[r] = randNode(t, depth - 1);
      }
      return node;
    };
    const problems: string[] = [];
    for (let iter = 0; iter < 120; iter++) {
      const defaults: Record<string, Node> = {};
      for (const n of names) if (rnd() < 0.8) defaults[n] = randNode(n, 2);
      const lens: LensNarrowing = {
        parent: fuzzBase,
        mapDefaults: { app: { models: defaults } },
        ...(rnd() < 0.5 && { root: randNode('A', 3) }),
      };
      const projection = projectLens(lens);
      const byModel = projectLens(lens, { by: 'model' });
      for (const [key, visit] of Object.entries(projection))
        if (!isDeepStrictEqual(lensVisit(lens, key.split('.').slice(1).join('.')), visit))
          problems.push(`${iter} lensVisit ≠ projectLens at ${key}`);
      const reach: string[] = [];
      const walk = (path: string[], model: string) => {
        reach.push(path.join('.'));
        if (path.length >= 4) return;
        for (const [r, t] of rels[model]) {
          const next = [...path, r];
          if (lensVisit(lens, next.join('.'))) walk(next, t);
        }
      };
      walk([], 'A');
      const select = toLensSelect(lens).select;
      for (const p of reach) {
        const visit = lensVisit(lens, p);
        const key = ['A', ...(p ? p.split('.') : [])].join('.');
        if (!visit || !projection[key]) {
          problems.push(`${iter} ${key} admitted but not projected`);
          continue;
        }
        for (const col of ['id', 'x', 'y']) {
          const gate = walkLensPath(lens, p ? `${p}.${col}` : col).outcome === 'resolved';
          if (gate !== col in visit.fields)
            problems.push(`${iter} gate ≠ lensVisit at ${p}.${col}`);
          if (gate && !(col in (byModel.maps.app.models[visit.model]?.fields ?? {})))
            problems.push(`${iter} by-model hides ${visit.model}.${col}`);
          let at: { select?: Record<string, unknown> } | undefined = { select };
          for (const seg of p ? p.split('.') : [])
            at = at?.select?.[seg] as { select?: Record<string, unknown> } | undefined;
          // A visit that shows no column is fetched by its key alone (Prisma can't select nothing):
          // a relation by its join key or `id`, the root by its `id` (R7-4).
          const keyOnly =
            !Object.values(visit.fields).some((entry) => entry.kind === 'scalar') && col === 'id';
          if (!!at?.select?.[col] !== gate && !keyOnly)
            problems.push(`${iter} select ≠ gate at ${p}.${col}`);
        }
      }
      try {
        validateNarrowing(lens);
      } catch (error) {
        problems.push(`${iter} validateNarrowing threw ${(error as Error).message}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });
});

describe('F3: a grant reads only its own row: no scope ref climbs out of it', () => {
  const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
  const lenses: [string, LensNarrowing, Condition][] = [
    [
      '$$ value in a relation grant',
      {
        parent: base,
        root: {
          relations: {
            org: { where: rule({ field: 'name', operator: 'equals', path: '$$.name' }) },
          },
        },
      },
      rule({ field: 'org.name', operator: 'exists' }),
    ],
    [
      '$$ field in a relation grant',
      {
        parent: base,
        root: {
          relations: {
            org: { where: rule({ field: '$$.age', operator: 'greaterThan', value: 10 }) },
          },
        },
      },
      rule({ field: 'org.name', operator: 'exists' }),
    ],
    [
      '$$ in a model default',
      {
        parent: base,
        root: { relations: { posts: {} } },
        mapDefaults: {
          prisma: {
            models: {
              Post: { where: rule({ field: 'views', operator: 'lessThan', path: '$$.age' }) },
            },
          },
        },
      },
      rule({ field: 'posts', arrayOperator: 'any', condition: true }),
    ],
    [
      '$$ below a spelled path',
      {
        parent: base,
        root: {
          relations: {
            org: {
              relations: {
                users: { where: rule({ field: 'age', operator: 'lessThan', path: '$$.seats' }) },
              },
            },
          },
        },
      },
      rule({ field: 'org.users', arrayOperator: 'any', condition: true }),
    ],
  ];

  test.each(lenses)('%s: validateNarrowing and every posture refuse it', (_, n, crossing) => {
    expect(validateNarrowing(n).errors.map((e) => e.code)).toContain('scope_out_of_bounds');
    expect(() => toLensSelect(n)).toThrow(/climbs out of the grant/);
    expect(() => projectRows(n, rails.rows as never)).toThrow(/climbs out of the grant/);
    expect(() => narrowRule(crossing, n)).toThrow(/climbs out of the grant/);
    expect(() => toPrisma(crossing, { lens: n })).toThrow(/climbs out of the grant/);
    // A read crosses the grant only where its path does.
    if ((crossing as { field?: string }).field === 'org.name')
      expect(() => readLensValue(n, rails.rows[0] as never, 'org.name')).toThrow(
        /climbs out of the grant/,
      );
  });

  test('a $$ that stays inside the grant (one array down) is its own row: fine', () => {
    // The users hop is to-many: its grant is row-scoped, and `$$.age` inside it reads the user.
    const inside: LensNarrowing = {
      parent: base,
      root: {
        relations: {
          org: {
            relations: {
              users: {
                where: rule({
                  field: 'posts',
                  arrayOperator: 'any',
                  condition: { field: 'views', operator: 'lessThan', path: '$$.age' },
                }),
              },
            },
          },
        },
      },
    };
    // Its own row: no scope issue. The fetch select can't carry a column compared across scopes
    // as the users relation's Prisma where, so the lens is refused for that (round 9), not for
    // the ref.
    const { errors } = validateNarrowing(inside);
    expect(errors.map((e) => e.message).join()).not.toMatch(/climbs out/);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/^toLensSelect: the grant on 'org.users': .*Prisma/),
    ]);
    expect(() => projectRows(inside, rails.rows as never)).not.toThrow();
  });
});

describe('F4: enum columns compare exactly or not at all', () => {
  const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });

  test('enum = enum of the same type: every rail, and they agree', async () => {
    for (const operator of ['equals', 'notEquals']) {
      const r = rule({ field: 'role', operator, path: 'role' });
      expect(describeRule(r, base).supportedTargets.sort()).toEqual(['check', 'toPrisma', 'toSql']);
      const ran = await rails.run(r);
      expect(ran.sql).toEqual(ran.check);
      expect(ran.prisma).toEqual(ran.check);
    }
  });

  test.each<[string, Condition]>([
    ['an ordered enum comparison', rule({ field: 'role', operator: 'lessThan', path: 'role' })],
    ['an enum against text', rule({ field: 'name', operator: 'equals', path: 'role' })],
    ['text against an enum', rule({ field: 'role', operator: 'equals', path: 'name' })],
  ])('%s: refused on both compilers, and supportedTargets says so', (_, r) => {
    expect(() => toSql(r, { map, model: 'User', now: NOW })).toThrow(/enum/);
    expect(() => toPrisma(r, { map, model: 'User', now: NOW })).toThrow();
    expect(validateRule(r, { target: 'toSql', map, model: 'User' }).ok).toBe(false);
    expect(validateRule(r, { target: 'toPrisma', map, model: 'User' }).ok).toBe(false);
    expect(describeRule(r, base).supportedTargets).toEqual(['check']);
  });

  test('a literal enum comparison is unchanged', async () => {
    expect(await rails.run(rule({ field: 'role', operator: 'equals', value: 'admin' }))).toEqual(
      agree([1]),
    );
  });
});
