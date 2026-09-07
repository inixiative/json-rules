import { describe, expect, it } from 'bun:test';
import { ArrayOperator, check, Operator, toPrisma } from '../index';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import type { FieldMap, GroupByStep } from '../src/toPrisma/types';
import { getWhere } from './fixtures/helpers';

// `true` compiles to `{}`, which Prisma only reads as match-all at the top level and
// inside AND. Inside OR Prisma drops it — `OR: [x, {}]` is just `x` (verified against
// Prisma SQLite: `{ any: [customerId = mateo, true] }` returned zero rows for a
// customer scoped to sofia while check() passed every row) — and `NOT: {}` is not
// NOT(true). The logical builders therefore fold the boolean constants: a `true`
// arm absorbs an OR, a `false` arm absorbs an AND, and `NOT` of a constant is the
// other constant. `{ OR: [] }` is Prisma's documented match-nothing and is the only
// false shape emitted — no `{ id: null }` self-contradiction sentinel.

const mateo = { field: 'customerId', operator: Operator.equals, value: 'mateo' };
const gold = { field: 'tier', operator: Operator.equals, value: 'gold' };
const silver = { field: 'tier', operator: Operator.equals, value: 'silver' };
const MATEO = { customerId: { equals: 'mateo' } };
const GOLD = { tier: { equals: 'gold' } };
const SILVER = { tier: { equals: 'silver' } };
const NOTHING = { OR: [] };

/** Every `{}` or `{ OR: [] }` that sits under an OR arm or a NOT — the shapes Prisma
 * misreads. Walks the whole compiled where, including relation filters. */
const nestedConstants = (where: unknown, path = '$'): string[] => {
  if (Array.isArray(where)) return where.flatMap((w, i) => nestedConstants(w, `${path}[${i}]`));
  if (where === null || typeof where !== 'object') return [];
  const rec = where as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, val] of Object.entries(rec)) {
    if (key === 'OR' && Array.isArray(val)) {
      for (const [i, arm] of val.entries()) {
        if (isConstant(arm)) out.push(`${path}.OR[${i}]`);
      }
    }
    if (key === 'NOT' && isConstant(val)) out.push(`${path}.NOT`);
    out.push(...nestedConstants(val, `${path}.${key}`));
  }
  return out;
};
const isConstant = (w: unknown): boolean => {
  if (w === null || typeof w !== 'object' || Array.isArray(w)) return false;
  const keys = Object.keys(w);
  if (keys.length === 0) return true;
  const or = (w as Record<string, unknown>).OR;
  return keys.length === 1 && Array.isArray(or) && or.length === 0;
};

describe('toPrisma folds boolean constants through OR', () => {
  it('reproducer: `any: [x, true]` matches everything, like check()', () => {
    const rule = { any: [mateo, true] };
    expect(check(rule, { customerId: 'sofia' })).toBe(true);
    expect(getWhere(toPrisma(rule))).toEqual({});
  });

  it('a nested empty `all` is `true` and absorbs the OR too', () => {
    expect(getWhere(toPrisma({ any: [mateo, { all: [] }] }))).toEqual({});
  });

  it('`false` arms drop out of an OR', () => {
    expect(getWhere(toPrisma({ any: [mateo, false] }))).toEqual({ OR: [MATEO] });
    expect(getWhere(toPrisma({ any: [false, { any: [] }] }))).toEqual(NOTHING);
  });

  it('empty `any` is the documented match-nothing, not an id sentinel', () => {
    expect(getWhere(toPrisma({ any: [] }))).toEqual(NOTHING);
  });
});

describe('toPrisma folds boolean constants through AND', () => {
  it('`true` arms drop out of an AND', () => {
    expect(getWhere(toPrisma({ all: [mateo, true] }))).toEqual({ AND: [MATEO] });
    expect(getWhere(toPrisma({ all: [true, { all: [] }] }))).toEqual({});
  });

  it('a `false` arm absorbs the AND', () => {
    expect(getWhere(toPrisma({ all: [mateo, false] }))).toEqual(NOTHING);
    expect(getWhere(toPrisma({ all: [mateo, { any: [] }] }))).toEqual(NOTHING);
  });
});

describe('toPrisma folds boolean constants through the implication', () => {
  it('`if: true` never emits `NOT: {}`', () => {
    expect(getWhere(toPrisma({ if: true, then: gold }))).toEqual({ OR: [GOLD] });
    expect(getWhere(toPrisma({ if: true, then: gold, else: silver }))).toEqual({
      AND: [{ OR: [GOLD] }],
    });
  });

  it('`if: false` is vacuous without else and selects else with it', () => {
    expect(getWhere(toPrisma({ if: false, then: gold }))).toEqual({});
    expect(getWhere(toPrisma({ if: false, then: gold, else: silver }))).toEqual({
      AND: [{ OR: [SILVER] }],
    });
  });

  it('`then: true` is vacuous; `then: false` is the negated antecedent', () => {
    expect(getWhere(toPrisma({ if: mateo, then: true }))).toEqual({});
    expect(getWhere(toPrisma({ if: mateo, then: false }))).toEqual({ OR: [{ NOT: MATEO }] });
  });

  it('`else: false` keeps the deny branch without an id sentinel', () => {
    expect(getWhere(toPrisma({ if: mateo, then: gold, else: false }))).toEqual({
      AND: [{ OR: [{ NOT: MATEO }, GOLD] }, { OR: [MATEO] }],
    });
  });

  it('`else: true` drops the else arm', () => {
    expect(getWhere(toPrisma({ if: mateo, then: gold, else: true }))).toEqual({
      AND: [{ OR: [{ NOT: MATEO }, GOLD] }],
    });
  });
});

describe('toPrisma never nests a constant under OR or NOT', () => {
  const leaves = [mateo, gold];
  const constants = [true, false, { all: [] }, { any: [] }];
  const shapes: unknown[] = [];
  for (const c of constants) {
    for (const leaf of leaves) {
      shapes.push({ any: [leaf, c] }, { any: [c, leaf] }, { all: [leaf, c] });
      shapes.push({ if: c, then: leaf }, { if: leaf, then: c }, { if: leaf, then: gold, else: c });
      shapes.push({ if: c, then: leaf, else: silver }, { if: leaf, then: c, else: silver });
      shapes.push({ any: [{ all: [leaf, c] }, { if: c, then: leaf }] });
      shapes.push({
        field: 'posts',
        arrayOperator: ArrayOperator.any,
        condition: { any: [leaf, c] },
      });
    }
  }

  it.each(shapes.map((s) => [JSON.stringify(s), s] as const))('%s', (_, shape) => {
    expect(nestedConstants(getWhere(toPrisma(shape as never)))).toEqual([]);
  });
});

// A bridge predicate compiles to `{}` as the over-fetch sentinel. Under an OR that
// sentinel used to be dropped by Prisma, silently UNDER-fetching; folding it as `true`
// over-fetches the whole disjunction, which is the contract check() relies on.
describe('toPrisma bridge sentinel inside `any` over-fetches', () => {
  const prismaMap: FieldMap = {
    models: {
      FanUser: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          crmId: { kind: 'scalar', type: 'String' },
          tier: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const salesforceMap: FieldMap = {
    models: {
      Contact: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          industry: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };
  const bridge: Bridge = {
    endpoints: [
      { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
      { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
    ],
    cardinality: 'oneToOne',
  };
  const stitched = stitchFieldMaps({
    maps: { prisma: prismaMap, salesforce: salesforceMap },
    bridges: [bridge],
  });
  const opts = { map: stitched.maps.prisma, model: 'FanUser' };
  const tech = { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' };

  it('`any: [bridge, x]` compiles to match-all, not `OR: [{}, x]`', () => {
    expect(getWhere(toPrisma({ any: [tech, gold] }, opts))).toEqual({});
  });

  it('`all: [bridge, x]` keeps only the local arm', () => {
    expect(getWhere(toPrisma({ all: [tech, gold] }, opts))).toEqual({ AND: [GOLD] });
  });
});

// Count operators push a groupBy step into the build state as a side effect. Folding
// must not build an arm twice (duplicate steps) and must leave every emitted step ref
// pointing at the step that produced it.
describe('toPrisma folding keeps groupBy step state coherent', () => {
  const map: FieldMap = {
    models: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          tier: { kind: 'scalar', type: 'String' },
          posts: { kind: 'object', type: 'Post', isList: true, relationName: 'PostToUser' },
        },
      },
      Post: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          authorId: { kind: 'scalar', type: 'String' },
          published: { kind: 'scalar', type: 'Boolean' },
          author: {
            kind: 'object',
            type: 'User',
            relationName: 'PostToUser',
            fromFields: ['authorId'],
            toFields: ['id'],
          },
        },
      },
    },
  };
  const opts = { map, model: 'User' };
  const published = { field: 'published', operator: Operator.equals, value: true };
  const twoPosts = {
    field: 'posts',
    arrayOperator: ArrayOperator.atLeast,
    count: 2,
    condition: published,
  };
  const groupBySteps = (plan: ReturnType<typeof toPrisma>) =>
    plan.steps.filter((s): s is GroupByStep => s.operation === 'groupBy');

  it('`if: count, then: true` builds the antecedent once and folds to match-all', () => {
    const plan = toPrisma({ if: twoPosts, then: true }, opts);
    expect(groupBySteps(plan)).toHaveLength(1);
    expect(getWhere(plan)).toEqual({});
  });

  it('`any: [count, true]` folds to match-all; the built step is left in place', () => {
    const plan = toPrisma({ any: [twoPosts, true] }, opts);
    expect(groupBySteps(plan)).toHaveLength(1);
    expect(getWhere(plan)).toEqual({});
  });

  it('a surviving step ref still points at its own step after a sibling folds away', () => {
    const onePost = { ...twoPosts, count: 1 };
    const plan = toPrisma({ all: [{ any: [twoPosts, false] }, { all: [onePost, true] }] }, opts);
    const steps = groupBySteps(plan);
    expect(steps).toHaveLength(2);
    expect(steps[0].args.having).toEqual({ authorId: { _count: { gte: 2 } } });
    expect(steps[1].args.having).toEqual({ authorId: { _count: { gte: 1 } } });
    expect(getWhere(plan)).toEqual({
      AND: [{ OR: [{ id: { in: { __step: 0 } } }] }, { AND: [{ id: { in: { __step: 1 } } }] }],
    });
  });

  it('`condition: true` on a count operator is still an empty groupBy where', () => {
    const plan = toPrisma({ ...twoPosts, condition: true }, opts);
    expect(groupBySteps(plan)[0].args.where).toEqual({});
  });
});
