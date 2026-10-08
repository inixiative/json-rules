import { describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  type FieldMap,
  type Lens,
  type LensNarrowing,
  narrowRule,
  projectLens,
  projectRows,
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
import { map } from './rails/harness';

// The adversarial review of 3.4 (round 6): each finding's repro, failing first.

const rule = (r: object): Condition => r as Condition;
const s = (t: string) => ({ kind: 'scalar', type: t }) as const;
const o = (t: string, isList = false) => ({ kind: 'object', type: t, isList }) as const;

// Whether any posture refuses the lens at runtime (a LensRefusal), over the rules the gate admits.
const runtimeRefuses = (lens: LensNarrowing, rules: Condition[] = [], rows: object[] = []) => {
  const attempts: (() => unknown)[] = [
    () => projectLens(lens),
    () => projectLens(lens, { by: 'model' }),
    () => toLensSelect(lens),
    () => toSourceQueries(lens),
    () => projectRows(lens, rows as never),
    // The gate reports a grant it refuses on the rule's visits; narrowRule runs on what it admits.
    ...rules.map((r) => () => {
      const gate = validateRuleInLens(r, lens);
      const refusal = gate.errors.find((e) =>
        /later layer's grant|climbs out of the grant|reads the root row|cannot re-root/.test(
          e.message,
        ),
      );
      if (refusal) throw Object.assign(new Error(refusal.message), { refusal: true });
      if (gate.ok) narrowRule(r, lens);
    }),
  ];
  for (const [i, attempt] of attempts.entries())
    try {
      attempt();
    } catch (error) {
      if (
        (error as Error).constructor.name === 'LensRefusal' ||
        (error as { refusal?: boolean }).refusal
      ) {
        lastRefusal = `posture ${i}: ${(error as Error).message}`;
        return true;
      }
    }
  return false;
};
let lastRefusal = '';

describe('R6-1/R6-3: one check decides a later grant, at the visits it applies to', () => {
  test('a: a later grant on a column its parent hides is refused, by validation and runtime', () => {
    const schema: FieldMap = {
      models: {
        User: {
          fields: { id: s('String'), name: s('String'), salary: s('Int'), posts: o('Post', true) },
        },
        Post: { fields: { id: s('String'), title: s('String'), secret: s('String') } },
      },
    };
    const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'User' });
    const l1: LensNarrowing = {
      parent: base,
      root: { omits: ['salary'], relations: { posts: { omits: ['secret'] } } },
    };
    const cases: LensNarrowing[] = [
      {
        parent: l1,
        root: { where: rule({ field: 'salary', operator: 'greaterThan', value: 100000 }) },
      },
      {
        parent: l1,
        root: {
          relations: {
            posts: { where: rule({ field: 'secret', operator: 'equals', value: 'x' }) },
          },
        },
      },
      {
        parent: l1,
        mapDefaults: {
          app: {
            models: { Post: { where: rule({ field: 'secret', operator: 'equals', value: 'x' }) } },
          },
        },
      },
    ];
    for (const l2 of cases) {
      expect(validateNarrowing(l2).ok).toBe(false);
      expect(
        runtimeRefuses(l2, [rule({ field: 'posts', arrayOperator: 'any', condition: true })]),
      ).toBe(true);
    }
  });

  const amr: FieldMap = {
    models: {
      A: { fields: { id: s('String'), x: s('String'), m: o('M'), m2: o('M') } },
      M: { fields: { id: s('String'), flag: s('Boolean'), r: o('R') } },
      R: { fields: { id: s('String'), k: s('Int') } },
    },
  };
  const amrBase = createLens({ maps: { app: amr }, mapName: 'app', model: 'A' });
  const kIsOne = rule({ field: 'r.k', operator: 'equals', value: 1 });

  test('b: a later grant at a visit a layer-1 grant crosses: validation and runtime agree', () => {
    const l1: LensNarrowing = {
      parent: amrBase,
      mapDefaults: {
        app: { models: { A: { relations: { m: {} } }, M: { relations: { r: {} } } } },
      },
      root: {
        where: rule({ field: 'm2.flag', operator: 'equals', value: true }),
        sources: { x: { where: rule({ field: 'm2.flag', operator: 'equals', value: true }) } },
      },
    };
    const l2: LensNarrowing = {
      parent: l1,
      mapDefaults: { app: { models: { M: { where: kIsOne } } } },
    };
    expect(validateNarrowing(l2).ok).toBe(
      !runtimeRefuses(l2, [rule({ field: 'm.r.k', operator: 'exists' })]),
    );
  });

  test('c: a turn-on the intrinsic visit does not see does not refuse what runtime applies', () => {
    for (const l1 of [
      { parent: amrBase, root: { relations: { m: { relations: { r: {} } } } } },
      {
        parent: amrBase,
        mapDefaults: { app: { models: { A: { relations: { m: { relations: { r: {} } } } } } } },
      },
    ] as LensNarrowing[]) {
      const l2: LensNarrowing = {
        parent: l1,
        mapDefaults: { app: { models: { M: { where: kIsOne } } } },
      };
      expect(validateNarrowing(l2).ok).toBe(true);
      expect(runtimeRefuses(l2, [rule({ field: 'm.r.k', operator: 'exists' })])).toBe(false);
    }
  });

  test('g: a restated relation’s nested where is checked only where it is shown', () => {
    const schema: FieldMap = {
      models: {
        A: { fields: { id: s('String'), m: o('M'), r0: o('R') } },
        M: { fields: { id: s('String'), r: o('R') } },
        R: { fields: { id: s('String'), s: o('S'), m: o('M') } },
        S: { fields: { id: s('String'), k: s('Int') } },
      },
    };
    const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'A' });
    const l1: LensNarrowing = {
      parent: base,
      root: { relations: { r0: { relations: { m: {} } } } },
      mapDefaults: {
        app: {
          models: {
            A: { relations: { m: {} } },
            M: { relations: { r: {} } },
            R: { relations: { s: {} } },
          },
        },
      },
    };
    const l2: LensNarrowing = {
      parent: l1,
      mapDefaults: {
        app: {
          models: {
            M: {
              relations: { r: { where: rule({ field: 's.k', operator: 'equals', value: 1 }) } },
            },
          },
        },
      },
    };
    expect(validateNarrowing(l2).ok).toBe(
      !runtimeRefuses(l2, [rule({ field: 'm.r.s.k', operator: 'exists' })]),
    );
  });

  test('random later grants: validateNarrowing.ok ⇔ no posture refuses', () => {
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
    const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'A' });
    const rnd = mulberry32(11);
    const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
    type Node = {
      picks?: string[];
      omits?: string[];
      where?: Condition;
      relations?: Record<string, Node>;
    };
    // A grant reading a random column one or two hops out.
    const grant = (model: string): Condition => {
      const [r] = pick(rels[model]);
      const toOne = !rels[model].find(([name]) => name === r)?.[2];
      if (rnd() < 0.4) return rule({ field: pick(['x', 'y']), operator: 'exists' });
      if (!toOne)
        return rule({
          field: r,
          arrayOperator: 'any',
          condition: { field: pick(['x', 'y']), operator: 'exists' },
        });
      return rule({ field: `${r}.${pick(['x', 'y'])}`, operator: 'exists' });
    };
    const randNode = (model: string, depth: number, grants: boolean): Node => {
      const node: Node = {};
      if (rnd() < 0.3) node.picks = [pick(['x', 'y'])];
      if (rnd() < 0.2) node.omits = [pick(rels[model])[0]];
      if (grants && rnd() < 0.5) node.where = grant(model);
      if (depth > 0 && rnd() < 0.6) {
        node.relations = {};
        for (const [r, t] of rels[model])
          if (rnd() < 0.5) node.relations[r] = randNode(t, depth - 1, grants);
      }
      return node;
    };
    const mismatches: string[] = [];
    for (let iter = 0; iter < 150; iter++) {
      const defaults: Record<string, Node> = {};
      for (const n of names) if (rnd() < 0.8) defaults[n] = randNode(n, 1, false);
      const l1: LensNarrowing = {
        parent: base,
        mapDefaults: { app: { models: defaults } },
        root: randNode('A', 2, rnd() < 0.5),
      };
      if (!validateNarrowing(l1).ok) continue;
      const later: Record<string, Node> = {};
      for (const n of names) if (rnd() < 0.5) later[n] = { where: grant(n) };
      const l2: LensNarrowing = {
        parent: l1,
        mapDefaults: { app: { models: later } },
        ...(rnd() < 0.5 && { root: { where: grant('A') } }),
      };
      const rules = ['id', 'b.id', 'd.id', 'b.c.id', 'd.b.id'].map((f) =>
        rule({ field: f, operator: 'exists' }),
      );
      const valid = validateNarrowing(l2).ok;
      const refused = runtimeRefuses(l2, rules);
      if (valid === refused)
        mismatches.push(
          `${iter}: valid=${valid} refused=${refused} ${lastRefusal} ${JSON.stringify(l2.mapDefaults)} ${JSON.stringify(l2.root)} L1 ${JSON.stringify(l1.root)} ${JSON.stringify(l1.mapDefaults)}`,
        );
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
  });
});

describe('R6-2: a pointer drops only its own layer’s carried grants', () => {
  test('a later layer’s grant keeps the pointing layer’s narrowing', () => {
    const schema: FieldMap = {
      models: {
        Post: {
          fields: {
            id: s('String'),
            authorId: s('String'),
            author: { ...o('User'), relationName: 'PA' },
            comments: { ...o('Comment', true), relationName: 'PC' },
          },
        },
        User: {
          fields: {
            id: s('String'),
            name: s('String'),
            posts: { ...o('Post', true), relationName: 'PA' },
          },
        },
        Comment: {
          fields: {
            id: s('String'),
            postId: s('String'),
            body: s('String'),
            deleted: s('Boolean'),
            post: { ...o('Post'), relationName: 'PC' },
          },
        },
      },
    };
    const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'Post' });
    const l0: LensNarrowing = { parent: base, root: { relations: { author: {}, comments: {} } } };
    const l1: LensNarrowing = {
      parent: l0,
      mapDefaults: {
        app: {
          models: {
            Comment: { where: rule({ field: 'deleted', operator: 'equals', value: false }) },
            User: { sources: { name: true } },
          },
        },
      },
      root: { relations: { author: { sources: { name: { from: 'mapDefaults' } } } } },
    } as LensNarrowing;
    const l2: LensNarrowing = {
      parent: l1,
      root: {
        where: rule({
          field: 'comments',
          arrayOperator: 'any',
          condition: { field: 'body', operator: 'equals', value: 'x' },
        }),
      },
    };
    const [query] = toSourceQueries(l2);
    expect(JSON.stringify(query.composedWhere)).toContain('"deleted"');
  });
});

describe('R6-4: no answer outlives the lens it came from', () => {
  test('mutating a narrowing in place between calls gives a fresh result', () => {
    const schema: FieldMap = {
      models: {
        A: { fields: { id: s('String'), p: o('P'), q: o('Q') } },
        P: { fields: { id: s('String'), t: o('T') } },
        Q: { fields: { id: s('String'), t: o('T') } },
        T: { fields: { id: s('String'), secret: s('String') } },
      },
    };
    const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'A' });
    const models: Record<string, { relations: Record<string, object> }> = {
      A: { relations: { p: {}, q: {} } },
      P: { relations: { t: {} } },
      Q: { relations: { t: {} } },
    };
    const l1: LensNarrowing = { parent: base, mapDefaults: { app: { models } } };
    expect(walkLensPath(l1, 'q.t.secret').outcome).toBe('hidden');
    models.P.relations = {};
    expect(walkLensPath(l1, 'q.t.secret').outcome).toBe('resolved');
    expect(walkLensPath(l1, 'p.t.secret').outcome).toBe('hidden');
  });
});

describe('R6-5: presence never fetches a hidden column', () => {
  test('presence fetches a key, never another hidden column; a keyless model is not fetched', () => {
    const schema = {
      models: {
        User: { fields: { id: s('String'), profile: o('Profile') } },
        Profile: { fields: { ssn: s('String'), name: s('String') } },
      },
    } as FieldMap;
    const base: Lens = createLens({ maps: { app: schema }, mapName: 'app', model: 'User' });
    const l1: LensNarrowing = {
      parent: base,
      root: { relations: { profile: { picks: ['name'] } } },
    };
    const l2: LensNarrowing = { parent: l1, root: { relations: { profile: { omits: ['name'] } } } };
    expect(JSON.stringify(toLensSelect(l2).select)).not.toContain('ssn');
    // Profile has no key: it is not fetched for presence, rather than by an arbitrary column.
    expect(toLensSelect(l2).select.profile).toBeUndefined();
    expect(JSON.stringify(toLensSelect(l1).select)).toContain('"name"');
  });
});

describe('R6-6: the gate refuses what narrowRule cannot re-root', () => {
  const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
  const lens: LensNarrowing = {
    parent: base,
    root: { relations: { org: {} } },
    mapDefaults: {
      prisma: {
        models: {
          Org: {
            where: rule({
              field: 'users',
              arrayOperator: 'all',
              // `$$.seats` reads the Org row: re-rooted under `org`, it would read the User.
              condition: { field: 'age', operator: 'greaterThan', path: '$$.seats' },
            }),
          },
        },
      },
    },
  };
  const across = rule({ field: 'org.name', operator: 'equals', value: 'Acme' });

  test('validateNarrowing and validateRuleInLens refuse it, with narrowRule’s message', () => {
    expect(
      validateNarrowing(lens)
        .errors.map((e) => e.message)
        .join(),
    ).toMatch(/cannot re-root/);
    const gate = validateRuleInLens(across, lens);
    expect(gate.ok).toBe(false);
    expect(gate.errors[0].message).toMatch(/cannot re-root/);
    expect(() => narrowRule(across, lens)).toThrow(/cannot re-root/);
    expect(() => toPrisma(across, { lens })).toThrow(/leaves the lens|cannot re-root/);
    expect(() => toSql(across, { lens })).toThrow(/leaves the lens|cannot re-root/);
  });
});

describe('LOW: a scalar column compared with a list column', () => {
  const lists: FieldMap = {
    enums: { Role: ['admin', 'member'] },
    models: {
      User: {
        fields: {
          id: s('Int'),
          name: s('String'),
          tags: { kind: 'scalar', type: 'String', isList: true },
          role: { kind: 'enum', type: 'Role' },
          roles: { kind: 'enum', type: 'Role', isList: true },
        },
      },
    },
  };
  test.each([
    ['role', 'roles'],
    ['name', 'tags'],
    ['tags', 'name'],
  ])('%s against %s: refused on both compilers', (field, path) => {
    const r = rule({ field, operator: 'equals', path });
    expect(() => toSql(r, { map: lists, model: 'User' })).toThrow(/list/);
    expect(() => toPrisma(r, { map: lists, model: 'User' })).toThrow(/list/);
    expect(validateRule(r, { target: 'toSql', map: lists, model: 'User' }).ok).toBe(false);
    expect(validateRule(r, { target: 'toPrisma', map: lists, model: 'User' }).ok).toBe(false);
  });

  test('nested default relation objects apply along spelled edges too', () => {
    const schema: FieldMap = {
      models: {
        A: { fields: { id: s('String'), m: o('M') } },
        M: { fields: { id: s('String'), r: o('R') } },
        R: { fields: { id: s('String') } },
      },
    };
    const base = createLens({ maps: { app: schema }, mapName: 'app', model: 'A' });
    const spelled: LensNarrowing = {
      parent: base,
      root: { relations: { m: {} } },
      mapDefaults: { app: { models: { A: { relations: { m: { relations: { r: {} } } } } } } },
    };
    expect(walkLensPath(spelled, 'm.r.id').outcome).toBe('resolved');
  });
});
