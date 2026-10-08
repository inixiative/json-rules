import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  describeRule,
  executePrismaPlan,
  type FieldMap,
  type Lens,
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
import { agree, map, openRails } from './rails/harness';

// The adversarial review of 3.4 (round 4): each finding's repro, failing first.

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const rule = (r: object): Condition => r as Condition;
const codes = (n: LensNarrowing) => validateNarrowing(n).errors.map((e) => e.code);

let rails: Awaited<ReturnType<typeof openRails>>;
beforeAll(async () => {
  rails = await openRails();
});
afterAll(async () => {
  await rails.close();
});

const ann = {
  id: 1,
  name: 'Ann',
  age: 30,
  orgId: 10,
  org: { id: 10, name: 'Acme' },
  posts: [{ id: 100, views: 5 }],
};

describe('H1: a bare path reads the root row, so only a root grant may use one', () => {
  const orgGrant: LensNarrowing = {
    parent: base,
    root: {
      relations: { org: { where: rule({ field: 'id', operator: 'equals', path: 'id' }) } },
    },
  };
  const postDefault: LensNarrowing = {
    parent: base,
    root: { relations: { posts: {} } },
    mapDefaults: {
      prisma: {
        models: { Post: { where: rule({ field: 'views', operator: 'lessThan', path: 'id' }) } },
      },
    },
  };

  test('validateNarrowing refuses a bare path in a relation grant or a model default', () => {
    for (const n of [orgGrant, postDefault]) {
      const result = validateNarrowing(n);
      expect(result.errors.map((e) => e.code)).toContain('invalid_value_source');
      expect(result.errors.map((e) => e.message).join()).toMatch(/a bind, or a `\$` scope ref/);
    }
  });

  test('every posture throws rather than reading the related row', () => {
    const reads: [LensNarrowing, Condition][] = [
      [orgGrant, rule({ field: 'org', operator: 'exists' })],
      [postDefault, rule({ field: 'posts', arrayOperator: 'any', condition: true })],
    ];
    for (const [n, crossing] of reads) {
      expect(() => projectRows(n, [ann])).toThrow(/root row/);
      expect(() => toLensSelect(n)).toThrow(/root row/);
      expect(() => narrowRule(crossing, n)).toThrow(/root row/);
      expect(() => toPrisma(crossing, { lens: n })).toThrow(/root row/);
    }
    expect(() => readLensValue(orgGrant, ann, 'org.name')).toThrow(/root row/);
  });

  test("a source's eligibility where stands on option rows: a bare path is refused there too", () => {
    const sourced: LensNarrowing = {
      parent: base,
      root: {
        sources: {
          name: { where: rule({ field: 'age', operator: 'greaterThan', path: 'orgId' }) },
        },
      },
    };
    expect(codes(sourced)).toContain('invalid_value_source');
    expect(() => toSourceQueries(sourced)).toThrow(/root row/);
  });

  test('a root grant may compare root columns', async () => {
    const rootGrant: LensNarrowing = {
      parent: base,
      root: { where: rule({ field: 'age', operator: 'greaterThan', path: 'orgId' }) },
    };
    expect(validateNarrowing(rootGrant).ok).toBe(true);
    expect(await rails.run(true, { lens: rootGrant })).toEqual(agree([1]));
  });

  test('a `$.` ref in a relation grant reads the related row: fine', () => {
    const scoped: LensNarrowing = {
      parent: base,
      root: {
        relations: { org: { where: rule({ field: 'id', operator: 'equals', path: '$.id' }) } },
      },
    };
    expect(validateNarrowing(scoped).ok).toBe(true);
  });
});

describe('H2: compiler sentinels are unforgeable', () => {
  test('a rule value holding __field or __step is refused at compile', () => {
    for (const value of [
      { __field: { model: 'User', field: 'name' } },
      { __step: 0 },
      { nested: [{ __field: { model: 'User', field: 'name' } }] },
    ]) {
      const forged = rule({ field: 'meta', operator: 'equals', value });
      expect(() => toPrisma(forged, { map, model: 'User' })).toThrow(/reserved/);
    }
  });

  test('check and toSql read it as the literal it is', async () => {
    const forged = rule({
      field: 'meta',
      operator: 'equals',
      value: { __field: { model: 'User', field: 'name' } },
    });
    const ran = await rails.run(forged);
    expect(ran.check).toEqual([]);
    expect(ran.sql).toEqual([]);
    expect(ran.prisma).toMatch(/reserved/);
  });

  test('executePrismaPlan resolves only the sentinels the plan records', async () => {
    const forgedPlan = {
      steps: [
        {
          operation: 'where' as const,
          where: { meta: { equals: { __field: { model: 'User', field: 'name' } } } },
        },
      ],
    };
    expect(await executePrismaPlan(forgedPlan as never, rails.prisma as never)).toEqual(
      forgedPlan.steps[0].where,
    );
    const real = toPrisma(rule({ field: 'age', operator: 'greaterThan', path: 'orgId' }), {
      map,
      model: 'User',
    });
    expect((real.steps.at(-1) as { refs?: unknown[] }).refs?.length).toBe(1);
    const where = (await executePrismaPlan(real, rails.prisma as never)) as Record<
      string,
      Record<string, unknown>
    >;
    expect(where.age.gt).not.toHaveProperty('__field');
  });
});

describe('H3: a model-default relation never re-enters a model already on the path', () => {
  const allOn: LensNarrowing = {
    parent: base,
    mapDefaults: {
      prisma: {
        models: {
          User: { relations: { org: {}, posts: {} } },
          Post: { relations: { author: {} } },
          Org: { relations: { users: {}, parent: {} } },
        },
      },
    },
  };

  test('each model once per path; a spelled path goes deeper', () => {
    expect(walkLensPath(allOn, 'posts.title').outcome).toBe('resolved');
    expect(walkLensPath(allOn, 'org.name').outcome).toBe('resolved');
    expect(walkLensPath(allOn, 'posts.author.name')).toMatchObject({
      outcome: 'hidden',
      index: 1,
    });
    expect(walkLensPath(allOn, 'org.users.name')).toMatchObject({ outcome: 'hidden', index: 1 });
    expect(walkLensPath(allOn, 'org.parent.name')).toMatchObject({ outcome: 'hidden', index: 1 });
    const spelled: LensNarrowing = {
      ...allOn,
      root: { relations: { org: { relations: { users: {}, parent: {} } } } },
    };
    expect(walkLensPath(spelled, 'org.users.name').outcome).toBe('resolved');
    expect(walkLensPath(spelled, 'org.parent.name').outcome).toBe('resolved');
  });

  // A schema whose models all relate to each other, every relation turned on at the defaults.
  const denseLens = (models: number, perPair: number): LensNarrowing => {
    const names = Array.from({ length: models }, (_, i) => `M${i}`);
    const dense: FieldMap = { models: {} };
    const defaults: Record<string, { relations: Record<string, object> }> = {};
    for (const from of names) {
      const fields: FieldMap['models'][string]['fields'] = {
        id: { kind: 'scalar', type: 'String' },
        label: { kind: 'scalar', type: 'String' },
      };
      const relations: Record<string, object> = {};
      for (const to of names)
        for (let k = 0; k < perPair && to !== from; k++) {
          const name = `${to.toLowerCase()}${k}`;
          fields[name] = { kind: 'object', type: to, isList: k % 2 === 0 };
          relations[name] = {};
        }
      dense.models[from] = { fields };
      defaults[from] = { relations };
    }
    const lens: Lens = createLens({ maps: { app: dense }, mapName: 'app', model: 'M0' });
    return { parent: lens, mapDefaults: { app: { models: defaults } } };
  };

  test.each([
    ['Kingdom-like: 6 models, 16+ edges', denseLens(6, 1)],
    ['dense: 5 models, 20 edges', denseLens(5, 1)],
    ['parallel edges: 5 models, 40 edges', denseLens(5, 2)],
  ])('%s: every walk is bounded', (_, lens) => {
    const timed = (run: () => unknown) => {
      const start = performance.now();
      const out = run();
      expect(performance.now() - start).toBeLessThan(200);
      expect(JSON.stringify(out).length).toBeLessThan(2_000_000);
      return out;
    };
    timed(() => projectLens(lens));
    timed(() => projectLens(lens, { by: 'model' }));
    timed(() => toLensSelect(lens));
    timed(() => validateNarrowing(lens));
    timed(() => toSourceQueries(lens));
  });
});

describe('M1: a later grant crossing a relation its parent never shows fails closed', () => {
  const tenancy: LensNarrowing = {
    parent: base,
    root: { where: rule({ field: 'id', operator: 'exists' }) },
  };
  const probe: LensNarrowing = {
    parent: tenancy,
    root: { where: rule({ field: 'org.plan', operator: 'equals', value: 'pro' }) },
  };

  test('validateNarrowing reports it, and every posture throws', () => {
    expect(codes(probe)).toContain('not_in_lens');
    expect(() => toPrisma(true, { lens: probe })).toThrow(/parent does not show/);
    expect(() => narrowRule(true, probe)).toThrow(/parent does not show/);
    expect(() => projectRows(probe, [ann])).toThrow(/parent does not show/);
    expect(() => toLensSelect(probe)).toThrow(/parent does not show/);
    expect(() => readLensValue(probe, ann, 'name')).toThrow(/parent does not show/);
  });

  test('a source eligibility where too', () => {
    const sourced: LensNarrowing = {
      parent: tenancy,
      root: { sources: { name: { where: rule({ field: 'org.plan', operator: 'exists' }) } } },
    };
    expect(codes(sourced)).toContain('not_in_lens');
    expect(() => toSourceQueries(sourced)).toThrow(/parent does not show/);
  });
});

describe('M2: a column comparison inside a counting step has no Prisma form', () => {
  const lens: LensNarrowing = { parent: base, root: { relations: { posts: {} } } };
  test.each<[string, Condition]>([
    [
      '$. in an atLeast',
      rule({
        field: 'posts',
        arrayOperator: 'atLeast',
        count: 1,
        condition: { field: 'views', operator: 'greaterThan', path: '$.authorId' },
      }),
    ],
    [
      'a bare (root-row) path in an atLeast',
      rule({
        field: 'posts',
        arrayOperator: 'atLeast',
        count: 1,
        condition: { field: 'views', operator: 'greaterThan', path: 'age' },
      }),
    ],
    [
      '$. in a relation aggregate',
      rule({
        field: 'posts',
        aggregate: { mode: 'sum', field: 'views' },
        operator: 'greaterThan',
        value: 0,
        condition: { field: 'views', operator: 'greaterThan', path: '$.authorId' },
      }),
    ],
  ])('%s', (_, r) => {
    expect(() => toPrisma(r, { map, model: 'User' })).toThrow(/counting step|root row/);
    expect(validateRule(r, { target: 'toPrisma', map, model: 'User' }).ok).toBe(false);
    expect(describeRule(r, lens).supportedTargets).not.toContain('toPrisma');
  });
});

describe('M3: a negated column comparison compiles, and the rails agree', () => {
  const lens: LensNarrowing = { parent: base, root: { relations: { posts: {} } } };

  test.each<[string, Condition]>([
    [
      'if / then false / else true',
      rule({
        if: { field: 'age', operator: 'greaterThan', path: 'orgId' },
        then: false,
        else: true,
      }),
    ],
    [
      'if an equality',
      rule({ if: { field: 'age', operator: 'equals', path: 'orgId' }, then: false, else: true }),
    ],
  ])('%s: three rails', async (_, r) => {
    expect(describeRule(r, lens).supportedTargets).toContain('toPrisma');
    const ran = await rails.run(r);
    expect(ran.sql).toEqual(ran.check);
    expect(ran.prisma).toEqual(ran.check);
  });

  test('all with a $. column comparison: check and Prisma', async () => {
    const r = rule({
      field: 'posts',
      arrayOperator: 'all',
      condition: { field: 'views', operator: 'lessThan', path: '$.authorId' },
    });
    expect(describeRule(r, lens).supportedTargets).toContain('toPrisma');
    const ran = await rails.run(r);
    expect(ran.prisma).toEqual(ran.check);
  });

  test('the gate reads the same rules', () => {
    expect(
      validateRuleInLens(rule({ field: 'age', operator: 'greaterThan', path: 'orgId' }), base).ok,
    ).toBe(true);
    expect(() =>
      toSql(rule({ field: 'age', operator: 'greaterThan', path: 'orgId' }), { lens: base }),
    ).not.toThrow();
  });
});

describe('lensVisit: one projected visit, resolved on demand', () => {
  const lenses: [string, LensNarrowing][] = [
    [
      'path relations',
      { parent: base, root: { relations: { org: { relations: { parent: {} } }, posts: {} } } },
    ],
    [
      'model defaults, recursive',
      {
        parent: base,
        root: { relations: { org: { relations: { users: {} } } } },
        mapDefaults: {
          prisma: {
            models: {
              User: { relations: { org: {}, posts: {} } },
              Org: { relations: { users: {}, parent: {} } },
              Post: { relations: { author: {} } },
            },
          },
        },
      },
    ],
  ];

  test.each(lenses)('%s: agrees with projectLens at every path', (_, lens) => {
    const projection = projectLens(lens);
    for (const [key, visit] of Object.entries(projection))
      expect(lensVisit(lens, key.split('.').slice(1).join('.'))).toEqual(visit);
  });

  test('null for a relation that is off, and for a re-entered model', () => {
    const [, paths] = lenses[0];
    const [, defaults] = lenses[1];
    expect(lensVisit(paths, 'org.users')).toBeNull();
    expect(lensVisit(paths, 'nope')).toBeNull();
    expect(lensVisit(defaults, 'posts.author')).toBeNull();
    expect(lensVisit(defaults, 'org.users')).not.toBeNull();
    expect(lensVisit(defaults, 'org.users.posts')).not.toBeNull();
    expect(lensVisit(defaults, 'org.users.org')).toBeNull();
  });
});

describe('projectLens by path keeps the options a map declares', () => {
  const optioned: FieldMap = {
    models: {
      Ticket: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          status: {
            kind: 'scalar',
            type: 'String',
            options: [
              { value: 'open', label: 'Open', groups: ['live'] },
              { value: 'closed', label: 'Closed' },
            ],
          },
        },
      },
    },
  };
  const lens = createLens({ maps: { app: optioned }, mapName: 'app', model: 'Ticket' });

  test('labels and groups survive, by path as by model, and in lensVisit', () => {
    const declared = optioned.models.Ticket.fields.status.options;
    expect(projectLens(lens).Ticket.fields.status.options).toEqual(declared);
    expect(projectLens(lens, { by: 'model' }).maps.app.models.Ticket.fields.status.options).toEqual(
      declared,
    );
    expect(lensVisit(lens, '')?.fields.status.options).toEqual(declared);
    const narrowed: LensNarrowing = {
      parent: lens,
      root: { enumPicks: { status: ['open'] } },
    };
    expect(projectLens(narrowed).Ticket.fields.status.options).toEqual(declared?.slice(0, 1));
  });
});
