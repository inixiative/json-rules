import { describe, expect, test } from 'bun:test';
import {
  type Condition,
  check,
  createLens,
  type FieldMap,
  type FieldMapEntry,
  joinNarrowings,
  type Lens,
  type LensNarrowing,
  LensRefusal,
  type ModelNarrowing,
  narrowRule,
  projectRows,
  validateNarrowing,
  validateRuleInLens,
} from '../index';

type Layer = Omit<LensNarrowing, 'parent'>;

const str: FieldMapEntry = { kind: 'scalar', type: 'String' };
const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: str,
        name: str,
        email: str,
        tenantId: str,
        role: { kind: 'enum', type: 'Role' },
        org: { kind: 'object', type: 'Org' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Org: { fields: { id: str, name: str, plan: str } },
    Post: {
      fields: {
        id: str,
        title: str,
        published: { kind: 'scalar', type: 'Boolean' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        author: { kind: 'object', type: 'User' },
        org: { kind: 'object', type: 'Org' },
      },
    },
  },
  enums: { Role: ['admin', 'member', 'guest'] },
};
const lens: Lens = createLens({ maps: { app: map }, mapName: 'app', model: 'User' });

const chainOf = (layers: readonly Layer[]): Lens | LensNarrowing =>
  layers.reduce<Lens | LensNarrowing>((parent, layer) => ({ parent, ...layer }), lens);

const refusal = (fn: () => unknown): { code: string; path?: string } => {
  try {
    fn();
  } catch (error) {
    if (error instanceof LensRefusal) return { code: error.code, path: error.path };
    throw error;
  }
  throw new Error('expected a refusal');
};

const users = [
  {
    id: 'u1',
    name: 'Ada',
    email: 'a@x',
    tenantId: 't1',
    role: 'admin',
    org: { id: 'o1', name: 'One', plan: 'paid' },
    posts: [
      { id: 'p1', title: 'A', published: true, deletedAt: null },
      { id: 'p2', title: 'B', published: false, deletedAt: '2026-01-01' },
    ],
  },
  {
    id: 'u2',
    name: 'Bo',
    email: 'b@x',
    tenantId: 't2',
    role: 'guest',
    org: null,
    posts: [{ id: 'p3', title: 'C', published: false, deletedAt: null }],
  },
  { id: 'u3', name: 'Cy', email: null, tenantId: 't1', role: 'member', posts: [] },
];

// The chain and the joined narrowing answer alike: same rows, same gate, same check() per row.
const expectSameAsChain = (layers: readonly Layer[], rules: readonly Condition[] = []) => {
  const chain = chainOf(layers);
  const joined: LensNarrowing = { parent: lens, ...joinNarrowings(lens, layers) };
  expect(validateNarrowing(joined).errors).toEqual([]);
  for (const keepClampColumns of [false, true])
    expect(projectRows(joined, users, { keepClampColumns })).toEqual(
      projectRows(chain, users, { keepClampColumns }),
    );
  for (const rule of rules) {
    const gate = validateRuleInLens(rule, chain).ok;
    expect(validateRuleInLens(rule, joined).ok).toBe(gate);
    if (!gate) continue;
    for (const user of users)
      expect(check(narrowRule(rule, joined), user) === true).toBe(
        check(narrowRule(rule, chain), user) === true,
      );
  }
};

describe('joinNarrowings: scalar picks, omits, where and model defaults', () => {
  test('picks intersect, omits union, a picked-and-omitted column leaves the picks', () => {
    const layers: Layer[] = [
      { root: { picks: ['id', 'name', 'email', 'role'] } },
      { root: { picks: ['id', 'name', 'email'] } },
      { root: { omits: ['email'] } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({ root: { picks: ['id', 'name'] } });
    expectSameAsChain(layers);
  });

  test('omits union across root and model defaults', () => {
    const layers: Layer[] = [
      {
        root: { omits: ['email'] },
        mapDefaults: { app: { models: { User: { omits: ['tenantId'] } } } },
      },
      { root: { omits: ['role'] } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      mapDefaults: { app: { models: { User: { omits: ['tenantId'] } } } },
      root: { omits: ['email', 'role'] },
    });
    expectSameAsChain(layers);
  });

  test('wheres conjoin as flat siblings of one all, each kept whole, in layer order', () => {
    const t1: Condition = { field: 'tenantId', operator: 'equals', value: 't1' };
    const named: Condition = { field: 'name', operator: 'notEmpty' };
    const pinned: Condition = { field: 'id', operator: 'in', value: ['u1', 'u3'] };
    const either: Condition = { any: [named, pinned] };
    const layers: Layer[] = [
      { root: { where: { all: [t1, named] } } },
      { root: { where: pinned } },
      { root: { where: either } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      root: { where: { all: [t1, named, pinned, either] } },
    });
    expectSameAsChain(layers);
  });

  test('a model default where conjoins with the layer before it, at the default', () => {
    const t1: Condition = { field: 'tenantId', operator: 'equals', value: 't1' };
    const admin: Condition = { field: 'role', operator: 'equals', value: 'admin' };
    const layers: Layer[] = [
      { mapDefaults: { app: { models: { User: { where: t1 } } } } },
      { mapDefaults: { app: { models: { User: { where: admin, picks: ['id', 'role'] } } } } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      mapDefaults: {
        app: { models: { User: { picks: ['id', 'role'], where: { all: [t1, admin] } } } },
      },
    });
    expectSameAsChain(layers);
  });

  test('a later layer may use negated operators in a where (a lens decides no permission)', () => {
    const layers: Layer[] = [
      { root: { where: { field: 'role', operator: 'notEquals', value: 'guest' } } },
      { root: { where: { field: 'id', operator: 'notIn', value: ['u3'] } } },
    ];
    expectSameAsChain(layers);
    expect(
      projectRows({ parent: lens, ...joinNarrowings(lens, layers) }, users).map((u) => u.id),
    ).toEqual(['u1']);
  });

  test('enum picks intersect and enum omits union, per field and per enum type', () => {
    const layers: Layer[] = [
      {
        root: { enumPicks: { role: ['admin', 'member'] } },
        mapDefaults: { app: { enums: { Role: { omits: ['guest'] } } } },
      },
      { root: { enumPicks: { role: ['member'] } } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      mapDefaults: { app: { enums: { Role: { omits: ['guest'] } } } },
      root: { enumPicks: { role: ['member'] } },
    });
    expectSameAsChain(layers, [{ field: 'role', operator: 'equals', value: 'admin' }]);
  });

  test('a path pick a same-layer model default hides is left out (it is hidden there either way)', () => {
    const layers: Layer[] = [
      { root: { picks: ['id', 'name', 'email'] } },
      { mapDefaults: { app: { models: { User: { omits: ['email'] } } } } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      mapDefaults: { app: { models: { User: { omits: ['email'] } } } },
      root: { picks: ['id', 'name'] },
    });
    expectSameAsChain(layers);
  });

  test('nothing about `id`: a join may drop it (keeping it is the host’s rule)', () => {
    const layers: Layer[] = [{}, { root: { omits: ['id'] } }];
    expect(joinNarrowings(lens, layers)).toEqual({ root: { omits: ['id'] } });
  });
});

describe('joinNarrowings: relations', () => {
  test('a relation the first layer turns on and a later layer omits is off', () => {
    const layers: Layer[] = [
      { root: { relations: { org: {}, posts: {} } } },
      { root: { omits: ['org'] } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      root: { omits: ['org'], relations: { org: {}, posts: {} } },
    });
    expectSameAsChain(layers, [{ field: 'org.name', operator: 'exists' }]);
  });

  test('a later layer restating a relation narrows that hop', () => {
    const layers: Layer[] = [
      { root: { relations: { posts: {} } } },
      {
        root: {
          relations: {
            posts: {
              picks: ['id', 'title'],
              where: { field: 'published', operator: 'equals', value: true },
            },
          },
        },
      },
    ];
    expect(joinNarrowings(lens, layers)).toEqual({
      root: {
        relations: {
          posts: {
            picks: ['id', 'title'],
            where: { field: 'published', operator: 'equals', value: true },
          },
        },
      },
    });
    expectSameAsChain(layers, [
      {
        field: 'posts',
        arrayOperator: 'all',
        condition: { field: 'title', operator: 'equals', value: 'A' },
      },
    ]);
  });

  test("a later where crossing a relation reads through the earlier layer's clamp on it", () => {
    const live: Condition = { field: 'deletedAt', operator: 'notExists' };
    const unpublished: Condition = { field: 'published', operator: 'equals', value: false };
    const layers: Layer[] = [
      { root: { relations: { posts: { where: live } } } },
      { root: { where: { field: 'posts', arrayOperator: 'none', condition: unpublished } } },
    ];
    // In the chain the second layer sees only live posts: u1's deleted, unpublished p2 does not count.
    expect(joinNarrowings(lens, layers)).toEqual({
      root: {
        relations: { posts: { where: live } },
        where: { field: 'posts', arrayOperator: 'none', condition: { all: [live, unpublished] } },
      },
    });
    expectSameAsChain(layers);
    expect(projectRows(chainOf(layers), users).map((u) => u.id)).toEqual(['u1', 'u3']);
  });

  test('a to-one hop is read through its clamp too', () => {
    const paid: Condition = { field: 'plan', operator: 'equals', value: 'paid' };
    const layers: Layer[] = [
      { root: { relations: { org: { where: paid } } } },
      { root: { where: { field: 'org.name', operator: 'equals', value: 'One' } } },
    ];
    expectSameAsChain(layers, [{ field: 'org.name', operator: 'exists' }]);
  });

  test('a restatement that narrows nothing is dropped where the first layer did not spell it', () => {
    const layers: Layer[] = [
      { mapDefaults: { app: { models: { User: { relations: { org: {} } } } } } },
      { root: { relations: { org: {} } } },
    ];
    expect(joinNarrowings(lens, layers)).toEqual(joinNarrowings(lens, layers.slice(0, 1)));
    expectSameAsChain(layers);
  });
});

describe('joinNarrowings: refusals', () => {
  test('an invalid layer: it names what the layers above hide', () => {
    expect(
      refusal(() =>
        joinNarrowings(lens, [{ root: { omits: ['email'] } }, { root: { picks: ['email'] } }]),
      ),
    ).toEqual({ code: 'not_visible', path: 'layers.1.root.picks' });
  });

  test('sources in a join of two layers', () => {
    expect(
      refusal(() =>
        joinNarrowings(lens, [
          { root: { sources: { name: true } } },
          { root: { omits: ['email'] } },
        ]),
      ),
    ).toEqual({ code: 'unjoinable_sources', path: 'root.sources' });
  });

  test("a later model-default where reading through an earlier layer's path clamp", () => {
    // Post's own default reads its author; the first layer clamps that hop on one path only.
    const layers: Layer[] = [
      {
        root: {
          relations: {
            posts: {
              relations: {
                author: { where: { field: 'tenantId', operator: 'equals', value: 't1' } },
              },
            },
          },
        },
      },
      {
        mapDefaults: {
          app: { models: { Post: { where: { field: 'author.name', operator: 'exists' } } } },
        },
      },
    ];
    expect(validateNarrowing(chainOf(layers) as LensNarrowing).ok).toBe(true);
    expect(refusal(() => joinNarrowings(lens, layers))).toEqual({
      code: 'unjoinable_clamp',
      path: 'User.posts',
    });
  });

  test('a later model-default restatement that would turn a relation on everywhere', () => {
    // The first layer turns User.org on at the root only; restated at User's default, one layer
    // would turn it on wherever User is visited, at posts.author too.
    const layers: Layer[] = [
      { root: { relations: { org: {}, posts: { relations: { author: {} } } } } },
      { mapDefaults: { app: { models: { User: { relations: { org: { picks: ['id'] } } } } } } },
    ];
    expect(validateNarrowing(chainOf(layers) as LensNarrowing).ok).toBe(true);
    expect(refusal(() => joinNarrowings(lens, layers))).toEqual({
      code: 'unjoinable_shape',
      path: 'User.posts.author',
    });
  });

  test('a later omit that cuts an edge of the default-relation tree', () => {
    // The defaults reach Org once, through User.org (Post.org then finds Org seen). Omitted in one
    // layer, User.org is no tree edge, so the tree would reach Org through posts.org instead.
    const layers: Layer[] = [
      {
        mapDefaults: {
          app: {
            models: {
              User: { relations: { org: {}, posts: {} } },
              Post: { relations: { org: {} } },
            },
          },
        },
      },
      { root: { omits: ['org'] } },
    ];
    expect(validateNarrowing(chainOf(layers) as LensNarrowing).ok).toBe(true);
    expect(refusal(() => joinNarrowings(lens, layers))).toEqual({
      code: 'unjoinable_shape',
      path: 'User.posts',
    });
  });

  test('an omit off the tree joins: nothing else reaches the model', () => {
    const layers: Layer[] = [
      { mapDefaults: { app: { models: { User: { relations: { org: {}, posts: {} } } } } } },
      { mapDefaults: { app: { models: { User: { omits: ['org'] } } } } },
    ];
    expectSameAsChain(layers, [{ field: 'org.name', operator: 'exists' }]);
  });
});

describe('joinNarrowings: determinism and algebra', () => {
  const layers: Layer[] = [
    {
      root: {
        relations: { posts: { where: { field: 'deletedAt', operator: 'notExists' } }, org: {} },
      },
    },
    { root: { omits: ['email'], relations: { posts: { picks: ['id', 'title'] } } } },
    {
      root: {
        where: {
          field: 'posts',
          arrayOperator: 'any',
          condition: { field: 'title', operator: 'equals', value: 'A' },
        },
      },
    },
  ];

  test('the same inputs give byte-identical output, keys and lists sorted', () => {
    const shuffled: Layer[] = [
      {
        root: {
          relations: { org: {}, posts: { where: { operator: 'notExists', field: 'deletedAt' } } },
        },
      },
      { root: { relations: { posts: { picks: ['title', 'id'] } }, omits: ['email'] } },
      layers[2] as Layer,
    ];
    expect(JSON.stringify(joinNarrowings(lens, shuffled))).toBe(
      JSON.stringify(joinNarrowings(lens, layers)),
    );
  });

  test('associative: join(a, b, c) is join(join(a, b), c)', () => {
    const ab = joinNarrowings(lens, layers.slice(0, 2));
    expect(JSON.stringify(joinNarrowings(lens, [ab, layers[2] as Layer]))).toBe(
      JSON.stringify(joinNarrowings(lens, layers)),
    );
  });

  test('one narrowing joins to itself; none to the empty narrowing; empty layers say nothing', () => {
    const one = joinNarrowings(lens, layers.slice(0, 1));
    expect(joinNarrowings(lens, [one])).toEqual(one);
    expect(one).toEqual(layers[0] as Layer);
    expect(joinNarrowings(lens, [])).toEqual({});
    expect(joinNarrowings(lens, [layers[0] as Layer, {}, { root: {} }])).toEqual(one);
  });

  test('three layers match the chain', () => {
    expectSameAsChain(layers, [
      { field: 'posts', arrayOperator: 'any', condition: { field: 'title', operator: 'exists' } },
      { field: 'email', operator: 'exists' },
    ]);
  });
});

// The shapes Kingdom stores: a resource kind's operations lens (signet's `operationsLens`: a root
// with one relation per operation segment, each operation a list of the rows it reads), a request
// layer that pins rows by id, an approval layer that picks fields, and a re-delegation after them.
describe('joinNarrowings: operations-lens grants', () => {
  const rowFields = { id: str, projectId: str, title: str, content: str };
  const ops: FieldMap = {
    models: {
      Ops: {
        fields: {
          documents: { kind: 'object', type: 'Ops_documents' },
          events: { kind: 'object', type: 'Ops_events' },
        },
      },
      Ops_documents: {
        fields: {
          read: { kind: 'object', type: 'Doc', isList: true },
          search: { kind: 'object', type: 'Doc', isList: true },
        },
      },
      Ops_events: { fields: { list: { kind: 'object', type: 'Event', isList: true } } },
      Doc: { fields: rowFields },
      Event: { fields: { id: str, kind: str, excerpt: str } },
    },
  };
  const base = createLens({ maps: { operations: ops }, mapName: 'operations', model: 'Ops' });
  const everyBranch: ModelNarrowing = {
    relations: {
      documents: { relations: { read: {}, search: {} } },
      events: { relations: { list: {} } },
    },
  };
  const rowLayer = (row: string, narrowing: ModelNarrowing): Layer => ({
    root: everyBranch,
    mapDefaults: { operations: { models: { [row]: narrowing } } },
  });
  const doc = (id: string) => ({ id, projectId: 'pr', title: `T${id}`, content: `C${id}` });
  const record = {
    documents: { read: [doc('d1'), doc('d2'), doc('d3')], search: [doc('d2'), doc('d4')] },
    events: { list: [{ id: 'e1', kind: 'push', excerpt: 'x' }] },
  };
  const chain = (layers: readonly Layer[]) =>
    layers.reduce<Lens | LensNarrowing>((parent, layer) => ({ parent, ...layer }), base);
  const same = (layers: readonly Layer[]) => {
    const body = joinNarrowings(base, layers);
    expect(validateNarrowing({ parent: base, ...body }).errors).toEqual([]);
    expect(projectRows({ parent: base, ...body }, [record])).toEqual(
      projectRows(chain(layers), [record]),
    );
    return body;
  };

  const request = rowLayer('Doc', {
    where: { field: 'id', operator: 'in', value: ['d1', 'd2', 'd4'] },
  });
  const approval = rowLayer('Doc', { picks: ['id', 'title'] });

  test('a request pinning rows and an approval picking fields store one narrowing', () => {
    expect(same([request, approval])).toEqual({
      mapDefaults: {
        operations: {
          models: {
            Doc: {
              picks: ['id', 'title'],
              where: { field: 'id', operator: 'in', value: ['d1', 'd2', 'd4'] },
            },
          },
        },
      },
      root: everyBranch,
    });
    expect(projectRows(chain([request, approval]), [record])).toEqual([
      {
        documents: {
          read: [
            { id: 'd1', title: 'Td1' },
            { id: 'd2', title: 'Td2' },
          ],
          search: [
            { id: 'd2', title: 'Td2' },
            { id: 'd4', title: 'Td4' },
          ],
        },
        events: { list: [{ id: 'e1', kind: 'push', excerpt: 'x' }] },
      },
    ]);
  });

  test('two pins keep both conditions whole (the web app’s oneLayer met them by hand)', () => {
    const approvedFewer = rowLayer('Doc', {
      picks: ['id', 'title', 'content'],
      where: { field: 'id', operator: 'in', value: ['d2', 'd4', 'd9'] },
    });
    expect(same([request, approvedFewer]).mapDefaults).toEqual({
      operations: {
        models: {
          Doc: {
            picks: ['content', 'id', 'title'],
            where: {
              all: [
                { field: 'id', operator: 'in', value: ['d1', 'd2', 'd4'] },
                { field: 'id', operator: 'in', value: ['d2', 'd4', 'd9'] },
              ],
            },
          },
        },
      },
    });
  });

  test('an approval that drops a branch turns it off', () => {
    const noEvents: Layer = { root: { omits: ['events'] } };
    const body = same([request, noEvents]);
    expect(body.root).toEqual({ ...everyBranch, omits: ['events'] });
  });

  test('a re-delegation narrows the joined grant again: three layers, one narrowing', () => {
    const redelegated = rowLayer('Doc', {
      picks: ['id'],
      where: { field: 'id', operator: 'equals', value: 'd2' },
    });
    const body = same([request, approval, redelegated]);
    expect(
      JSON.stringify(
        joinNarrowings(base, [joinNarrowings(base, [request, approval]), redelegated]),
      ),
    ).toBe(JSON.stringify(body));
    expect(projectRows({ parent: base, ...body }, [record])[0]?.documents).toEqual({
      read: [{ id: 'd2' }],
      search: [{ id: 'd2' }],
    });
  });
});
