import { describe, expect, test } from 'bun:test';
import {
  type Condition,
  createLens,
  describeRule,
  describeRuleSources,
  type FieldMapSet,
  type Lens,
  type LensNarrowing,
  narrowRule,
  projectLens,
  projectRows,
  readLensValue,
  toLensSelect,
  toPrisma,
  toSql,
  validateNarrowing,
  validateRuleInLens,
  walkLensPath,
} from '../index';
import { map } from './rails/harness';

// Relations are fields, off by default. The first narrowing over the base lens turns one on
// through the relation object — along the path (`root.relations.org`) or always-on at the model
// default (`mapDefaults…models.Org.relations`) — never through `picks`. A later layer only
// narrows what its parent exposes: it may omit a relation, or add that hop's narrowing.

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });

const codes = (rule: Condition, lens: Lens | LensNarrowing) =>
  validateRuleInLens(rule, lens).errors.map((e) => e.code);
const narrowingCodes = (n: LensNarrowing) => validateNarrowing(n).errors.map((e) => e.code);

const ann = {
  id: 1,
  name: 'Ann',
  org: { id: 10, name: 'Acme', plan: 'pro', parent: { id: 9, name: 'Root' } },
  posts: [{ id: 100, title: 'hello' }],
};

// Every posture answers the same: the gate, the compile, the read, the fetch, the cut.
const agree = (lens: Lens | LensNarrowing, path: string, open: boolean) => {
  const rule: Condition = { field: path, operator: 'exists' };
  const [relation] = path.split('.');
  expect(validateRuleInLens(rule, lens).ok).toBe(open);
  expect(walkLensPath(lens, path).outcome).toBe(open ? 'resolved' : 'hidden');
  const compiled = (() => {
    try {
      toPrisma(rule, { lens });
      return 'compiled';
    } catch (error) {
      return (error as Error).message;
    }
  })();
  expect(/leaves the lens/.test(compiled)).toBe(!open);
  const read = readLensValue(lens, ann, path);
  expect(read.ok || (read.ok === false && read.reason !== 'hidden')).toBe(open);
  if (path.includes('.')) {
    expect(Object.hasOwn(toLensSelect(lens).select, relation)).toBe(open);
    expect(Object.hasOwn(projectRows(lens, [ann])[0], relation)).toBe(open);
  }
};

const orgName: Condition = { field: 'org.name', operator: 'equals', value: 'Acme' };
const parentName: Condition = { field: 'org.parent.name', operator: 'equals', value: 'Acme' };

const withOrg: LensNarrowing = { parent: base, root: { relations: { org: {} } } };
const withParent: LensNarrowing = {
  parent: base,
  root: { relations: { org: { relations: { parent: {} } } } },
};

describe('a relation is off until a layer turns it on', () => {
  test("a bare lens reads its root model's own columns only", () => {
    expect(codes({ field: 'name', operator: 'equals', value: 'Ann' }, base)).toEqual([]);
    expect(codes(orgName, base)).toEqual(['not_in_lens']);
    expect(walkLensPath(base, 'org.name')).toMatchObject({ outcome: 'hidden', index: 0 });
    agree(base, 'org.name', false);
  });

  test('relations.org turns org on, one hop; org.parent needs its own', () => {
    expect(codes(orgName, withOrg)).toEqual([]);
    agree(withOrg, 'org.name', true);
    expect(codes(parentName, withOrg)).toEqual(['not_in_lens']);
    expect(walkLensPath(withOrg, 'org.parent.name')).toMatchObject({
      outcome: 'hidden',
      index: 1,
    });
    expect(readLensValue(withOrg, ann, 'org.parent.name')).toEqual({ ok: false, reason: 'hidden' });
    expect(codes(parentName, withParent)).toEqual([]);
    expect(readLensValue(withParent, ann, 'org.parent.name')).toEqual({ ok: true, value: 'Root' });
  });

  test('presence ops and array operators on an off relation are refused', () => {
    for (const operator of ['exists', 'notExists'] as const)
      expect(codes({ field: 'org', operator }, base)).toEqual(['not_in_lens']);
    const anyPost: Condition = {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'title', operator: 'exists' },
    };
    expect(codes(anyPost, base)).toEqual(['not_in_lens']);
    expect(codes(anyPost, { parent: base, root: { relations: { posts: {} } } })).toEqual([]);
  });

  test('picks names columns only: it neither turns a relation on nor hides one', () => {
    const picked: LensNarrowing = { parent: base, root: { picks: ['id'], relations: { org: {} } } };
    expect(codes(orgName, picked)).toEqual([]);
    expect(codes({ field: 'name', operator: 'exists' }, picked)).toEqual(['not_in_lens']);
  });

  test('describeRule reports the refusal', () => {
    expect(describeRule(orgName, base).errors.map((e) => e.code)).toEqual(['not_in_lens']);
  });

  test('value refs, offsets and orderBy cross only relations turned on', () => {
    const refs: Condition[] = [
      { field: 'name', operator: 'equals', path: 'org.name' },
      { field: 'name', operator: 'equals', path: '$.org.name' },
      { field: 'age', operator: 'greaterThan', value: 1, offset: { path: '$.org.seats' } },
    ] as Condition[];
    for (const rule of refs) {
      expect(codes(rule, base)).toEqual(['not_in_lens']);
      expect(codes(rule, withOrg)).toEqual([]);
    }
    const ordered = {
      field: 'posts',
      arrayOperator: 'any',
      orderBy: [{ field: 'author.age', direction: 'asc' }],
      take: 1,
      condition: { field: 'title', operator: 'exists' },
    } as unknown as Condition;
    expect(codes(ordered, { parent: base, root: { relations: { posts: {} } } })).toEqual([
      'not_in_lens',
    ]);
  });
});

describe('only the first narrowing over the base turns relations on', () => {
  test('a layer over an omits-only layer cannot turn a relation on: its parent exposes none', () => {
    const n1: LensNarrowing = { parent: base, root: { omits: ['age'] } };
    const n2: LensNarrowing = { parent: n1, root: { relations: { org: {} } } };
    expect(narrowingCodes(n2)).toEqual(['not_visible']);
    agree(n2, 'org.name', false);
  });

  test("adding a hop's narrowing hides nothing else", () => {
    const parent: LensNarrowing = { parent: base, root: { relations: { org: {}, posts: {} } } };
    const pro = { field: 'plan', operator: 'equals', value: 'pro' } as Condition;
    const child: LensNarrowing = { parent, root: { relations: { org: { where: pro } } } };
    expect(validateNarrowing(child).ok).toBe(true);
    const anyPost: Condition = {
      field: 'posts',
      arrayOperator: 'any',
      condition: { field: 'title', operator: 'exists' },
    };
    expect(codes(anyPost, child)).toEqual([]);
    agree(child, 'posts.title', true);
    expect(JSON.stringify(narrowRule(orgName, child))).toContain('"pro"');
  });

  test('a later layer hides a relation with omits, and the next cannot turn it back on', () => {
    const parent: LensNarrowing = { parent: base, root: { relations: { org: {}, posts: {} } } };
    const hidden: LensNarrowing = { parent, root: { omits: ['posts'] } };
    expect(validateNarrowing(hidden).ok).toBe(true);
    agree(hidden, 'posts.title', false);
    agree(hidden, 'org.name', true);
    const back: LensNarrowing = { parent: hidden, root: { relations: { posts: {} } } };
    expect(narrowingCodes(back)).toEqual(['not_visible']);
    agree(back, 'posts.title', false);
  });

  test('a later layer may narrow, not widen, below a relation its parent turned on', () => {
    const widen: LensNarrowing = {
      parent: withOrg,
      root: { relations: { org: { relations: { parent: {} } } } },
    };
    expect(narrowingCodes(widen)).toEqual(['not_visible']);
    expect(codes(parentName, widen)).toEqual(['not_in_lens']);
  });
});

describe('mapDefaults relations: on wherever the model is visited, each model once per path', () => {
  // Anchored at User: User.org is spelled; the defaults turn on Org.users, Org.parent, User.posts
  // and Post.author.
  const recursive: LensNarrowing = {
    parent: base,
    root: { relations: { org: {} } },
    mapDefaults: {
      prisma: {
        models: {
          User: { relations: { org: {}, posts: {} } },
          Org: { relations: { users: {}, parent: {} } },
          Post: { relations: { author: {} } },
        },
      },
    },
  };

  test('a model-default relation never re-enters a model on the path; spelling goes deeper', () => {
    expect(validateNarrowing(recursive).ok).toBe(true);
    expect(walkLensPath(recursive, 'org.name').outcome).toBe('resolved');
    expect(walkLensPath(recursive, 'posts.title').outcome).toBe('resolved');
    // User (the root) and Org are already on these paths.
    expect(walkLensPath(recursive, 'org.users')).toMatchObject({ outcome: 'hidden', index: 1 });
    expect(walkLensPath(recursive, 'org.parent')).toMatchObject({ outcome: 'hidden', index: 1 });
    expect(walkLensPath(recursive, 'posts.author')).toMatchObject({ outcome: 'hidden', index: 1 });
    const spelled: LensNarrowing = {
      ...recursive,
      root: { relations: { org: { relations: { users: {}, parent: {} } } } },
    };
    expect(walkLensPath(spelled, 'org.users.name').outcome).toBe('resolved');
    expect(walkLensPath(spelled, 'org.parent.name').outcome).toBe('resolved');
    // Below a spelled path the defaults go on, still never re-entering: Post is new here, User is not.
    expect(walkLensPath(spelled, 'org.users.posts.title').outcome).toBe('resolved');
    expect(walkLensPath(spelled, 'org.users.posts.author')).toMatchObject({
      outcome: 'hidden',
      index: 3,
    });
  });

  test('every posture shares the cap', () => {
    expect(readLensValue(recursive, ann, 'org.users')).toEqual({ ok: false, reason: 'hidden' });
    expect(Object.keys(projectLens(recursive)).sort()).toEqual(['User', 'User.org', 'User.posts']);
    expect(() =>
      toPrisma({ field: 'org.users', arrayOperator: 'any', condition: true } as never, {
        lens: recursive,
      }),
    ).toThrow(/leaves the lens/);
    const select = toLensSelect(recursive).select as Record<string, { select?: object }>;
    expect(Object.keys(select.org.select ?? {})).not.toContain('users');
    expect(Object.keys(select.posts.select ?? {})).not.toContain('author');
  });

  // Anchored at Post: Post.author reaches User, and User.org Org — no model repeats.
  const postBase = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'Post' });

  test('a multi-hop model-default relation object turns its nested relation on below it only', () => {
    const nested: LensNarrowing = {
      parent: postBase,
      mapDefaults: {
        prisma: { models: { Post: { relations: { author: { relations: { org: {} } } } } } },
      },
    };
    expect(validateNarrowing(nested).ok).toBe(true);
    expect(walkLensPath(nested, 'author.org.name').outcome).toBe('resolved');
    expect(walkLensPath(nested, 'author.posts')).toMatchObject({ outcome: 'hidden', index: 1 });
  });

  test("a model default's relation entry carries that hop's narrowing wherever it applies", () => {
    const adults = { field: 'age', operator: 'greaterThan', value: 17 } as Condition;
    const scoped: LensNarrowing = {
      parent: base,
      root: { relations: { org: { relations: { users: {} } } } },
      mapDefaults: { prisma: { models: { Org: { relations: { users: { where: adults } } } } } },
    };
    const rule: Condition = {
      field: 'org.users',
      arrayOperator: 'any',
      condition: { field: 'name', operator: 'exists' },
    };
    expect(JSON.stringify(narrowRule(rule, scoped))).toContain('"greaterThan"');
  });

  test('a later layer may restate a model-default relation its parent shows, to narrow it', () => {
    const shown: LensNarrowing = {
      parent: postBase,
      mapDefaults: {
        prisma: {
          models: { Post: { relations: { author: {} } }, User: { relations: { org: {} } } },
        },
      },
    };
    expect(walkLensPath(shown, 'author.org.name').outcome).toBe('resolved');
    const restated: LensNarrowing = {
      parent: shown,
      mapDefaults: {
        prisma: {
          models: {
            User: { relations: { org: { where: { field: 'plan', operator: 'exists' } } } },
          },
        },
      },
    };
    expect(validateNarrowing(restated).ok).toBe(true);
    const refused: LensNarrowing = {
      parent: withOrg,
      mapDefaults: { prisma: { models: { Org: { relations: { parent: {} } } } } },
    };
    expect(narrowingCodes(refused)).toEqual(['not_visible']);
    expect(codes(parentName, refused)).toEqual(['not_in_lens']);
  });
});

describe('validateNarrowing: picks names columns only', () => {
  test('omits may name a relation beside picks; omitting a column beside picks still conflicts', () => {
    const parent: LensNarrowing = { parent: base, root: { relations: { org: {}, posts: {} } } };
    expect(narrowingCodes({ parent, root: { picks: ['id'], omits: ['posts'] } })).toEqual([]);
    expect(narrowingCodes({ parent, root: { picks: ['id'], omits: ['name'] } })).toEqual([
      'conflicting_selection',
    ]);
  });

  test('a relation name in picks is an error, on a path node or a model default', () => {
    expect(narrowingCodes({ parent: base, root: { picks: ['id', 'org'] } })).toEqual([
      'wrong_kind',
    ]);
    expect(
      narrowingCodes({ parent: base, root: { relations: { org: { picks: ['id', 'parent'] } } } }),
    ).toEqual(['wrong_kind']);
    expect(
      narrowingCodes({
        parent: base,
        mapDefaults: { prisma: { models: { Org: { picks: ['name', 'users'] } } } },
      }),
    ).toEqual(['wrong_kind']);
  });
});

describe('sources read only relations turned on', () => {
  test('a dotted label or groupBy through an off relation is refused and dropped', () => {
    for (const spec of [{ label: 'org.name' }, { groupBy: 'org.plan' }]) {
      const off: LensNarrowing = { parent: base, root: { sources: { name: spec } } };
      expect(narrowingCodes(off)).toEqual(['invalid_source']);
      expect(projectLens(off).User.sourceLabels).toEqual({});
      expect(projectLens(off).User.sourceGroupBys).toEqual({});
      const on: LensNarrowing = {
        parent: base,
        root: { sources: { name: spec }, relations: { org: {} } },
      };
      expect(narrowingCodes(on)).toEqual([]);
    }
  });

  test("a source's eligibility where is a clamp: it may read any relation", () => {
    const n: LensNarrowing = {
      parent: base,
      root: {
        sources: { name: { where: { field: 'org.plan', operator: 'equals', value: 'pro' } } },
      },
    };
    expect(validateNarrowing(n).ok).toBe(true);
  });

  test('a source keyed on a relation, or a bare label naming one, is refused', () => {
    expect(
      narrowingCodes({ parent: base, root: { sources: { org: true }, relations: { org: {} } } }),
    ).toEqual(['wrong_kind']);
    expect(
      narrowingCodes({
        parent: base,
        root: { sources: { name: { label: 'org' } }, relations: { org: {} } },
      }),
    ).toEqual(['wrong_kind']);
  });

  test('describeRuleSources is silent on a rule through an off relation', () => {
    const sourced: LensNarrowing = {
      parent: base,
      mapDefaults: { prisma: { models: { Org: { sources: { plan: true } } } } },
    };
    const rule: Condition = { field: 'org.plan', operator: 'equals', value: 'pro' };
    expect(describeRuleSources(rule, sourced)).toEqual([]);
    expect(
      describeRuleSources(rule, { ...sourced, root: { relations: { org: {} } } }).map(
        (d) => d.path,
      ),
    ).toEqual(['User.org']);
  });
});

describe('a later layer clamps only on what its parent exposes', () => {
  const pro = { field: 'org.plan', operator: 'equals', value: 'pro' } as Condition;
  const tenancy: LensNarrowing = {
    parent: base,
    root: { where: { field: 'id', operator: 'exists' } as Condition },
  };

  test('the oracle: a delegate cannot probe a relation its parent never turns on', () => {
    const probe: LensNarrowing = {
      parent: tenancy,
      root: { where: pro, sources: { id: { where: pro } } },
    };
    const result = validateNarrowing(probe);
    expect(result.errors.map((e) => [e.path, e.code])).toEqual([
      ['root.where', 'not_in_lens'],
      ['root.sources.id', 'not_in_lens'],
    ]);
  });

  test('a later clamp may read a relation its parent turns on', () => {
    const shown: LensNarrowing = { parent: base, root: { relations: { org: {} } } };
    expect(validateNarrowing({ parent: shown, root: { where: pro } }).ok).toBe(true);
  });
});

describe('clamps read any relation', () => {
  test("the first narrowing's root, path and model where may read relations that are off", () => {
    const n: LensNarrowing = {
      parent: base,
      root: {
        where: { field: 'org.parent.plan', operator: 'equals', value: 'pro' },
        relations: { posts: { where: { field: 'author.org.name', operator: 'exists' } } },
      },
      mapDefaults: {
        prisma: { models: { Org: { where: { field: 'parent.seats', operator: 'exists' } } } },
      },
    };
    expect(validateNarrowing(n).ok).toBe(true);
  });
});

describe('fetch: exactly what is turned on, plus what clamps read', () => {
  test('toLensSelect selects no relation that is off', () => {
    expect(Object.keys(toLensSelect(base).select).sort()).toEqual(
      ['age', 'createdAt', 'id', 'meta', 'name', 'orgId', 'role', 'score', 'tags'].sort(),
    );
  });

  test("a relation only a clamp reads is fetched with that clamp's columns alone", () => {
    const n: LensNarrowing = {
      parent: base,
      root: { where: { field: 'org.plan', operator: 'equals', value: 'pro' } },
    };
    expect(toLensSelect(n).select.org).toEqual({ select: { plan: true } });
  });

  test('a relation that shows no column is fetched by its key alone', () => {
    const present: LensNarrowing = {
      parent: base,
      root: { where: { field: 'org', operator: 'exists' } },
    };
    expect(toLensSelect(present).select.org).toEqual({ select: { id: true } });
    const blind: LensNarrowing = { parent: base, root: { relations: { org: { picks: [] } } } };
    expect(toLensSelect(blind).select.org).toEqual({ select: { id: true } });
  });

  test('projectRows keeps only relations turned on', () => {
    const row = { id: 1, name: 'Ann', org: { id: 10, name: 'Acme' }, posts: [{ id: 100 }] };
    expect(projectRows(base, [row])).toEqual([{ id: 1, name: 'Ann' }]);
    expect(projectRows({ parent: base, root: { relations: { posts: {} } } }, [row])).toEqual([
      { id: 1, name: 'Ann', posts: [{ id: 100 }] },
    ]);
  });

  test('projectLens shows a relation field only where it is on', () => {
    const projection = projectLens(withOrg);
    expect(Object.keys(projection)).toEqual(['User', 'User.org']);
    expect(projection.User.fields.org).toBeDefined();
    expect(projection.User.fields.posts).toBeUndefined();
    expect(projection['User.org'].fields.parent).toBeUndefined();
    const surface = projectLens(withOrg, { by: 'model' });
    expect(Object.keys(surface.maps.prisma.models).sort()).toEqual(['Org', 'User']);
    expect(Object.keys(projectLens(base, { by: 'model' }).maps.prisma.models)).toEqual(['User']);
  });

  test('toSql { lens } refuses an off relation too', () => {
    expect(() => toSql(parentName, { lens: withOrg })).toThrow(/leaves the lens/);
  });
});

describe('a bridge is turned on by its key', () => {
  const maps: FieldMapSet['maps'] = {
    app: {
      models: {
        User: {
          fields: {
            name: { kind: 'scalar', type: 'String' },
            account: {
              kind: 'bridge',
              type: 'crm:Account',
              relationName: 'UserAccount',
              fromFields: [],
              toFields: [],
            },
          },
        },
      },
    },
    crm: { models: { Account: { fields: { tier: { kind: 'scalar', type: 'String' } } } } },
  };
  const bridged: Lens = { maps, mapName: 'app', model: 'User' };
  const rule: Condition = { field: 'account.tier', operator: 'equals', value: 'gold' };

  test('off by default, on through relations', () => {
    expect(codes(rule, bridged)).toEqual(['not_in_lens']);
    expect(codes(rule, { parent: bridged, root: { relations: { account: {} } } })).toEqual([]);
  });
});
