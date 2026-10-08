import { describe, expect, test } from 'bun:test';
import {
  assertValidNarrowing,
  bindLens,
  check,
  createLens,
  type FieldMap,
  type Lens,
  type LensNarrowing,
  materializeSourceQuery,
  materializeSources,
  projectLens,
  type Row,
  toSourceQueries,
  validateNarrowing,
} from '../index';

// A path source offers the rows reachable down its path; `from: 'mapDefaults'` offers the
// model's own source instead — every row the lens lets the model show, linked or not.
const app: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        orgId: { kind: 'scalar', type: 'String' },
        tagAttachments: {
          kind: 'object',
          type: 'TagAttachment',
          isList: true,
          relationName: 'UserAttachments',
          fromFields: [],
          toFields: [],
        },
      },
    },
    TagAttachment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        user: {
          kind: 'object',
          type: 'User',
          relationName: 'UserAttachments',
          fromFields: ['userId'],
          toFields: ['id'],
        },
        tag: {
          kind: 'object',
          type: 'Tag',
          relationName: 'TagAttachments',
          fromFields: ['tagId'],
          toFields: ['id'],
        },
      },
    },
    Tag: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        ownerId: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        attachments: {
          kind: 'object',
          type: 'TagAttachment',
          isList: true,
          relationName: 'TagAttachments',
          fromFields: [],
          toFields: [],
        },
        org: {
          kind: 'object',
          type: 'Org',
          relationName: 'TagOrg',
          fromFields: ['orgId'],
          toFields: ['id'],
        },
      },
    },
    Org: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        secret: { kind: 'scalar', type: 'Boolean' },
        tags: {
          kind: 'object',
          type: 'Tag',
          isList: true,
          relationName: 'TagOrg',
          fromFields: [],
          toFields: [],
        },
      },
    },
  },
};
const crm: FieldMap = {
  models: {
    Account: {
      fields: {
        kingdomOrgId: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const base: Lens = createLens({
  maps: { app, crm },
  bridges: [
    {
      endpoints: [
        { fieldMap: 'app', model: 'User', on: 'orgId' },
        { fieldMap: 'crm', model: 'Account', on: 'kingdomOrgId' },
      ],
      cardinality: 'oneToOne',
    },
  ],
  mapName: 'app',
  model: 'User',
});

const live = { field: 'deletedAt', operator: 'isEmpty' } as const;
const tagSource = { where: { field: 'ownerId', operator: 'equals', bind: 'orgId' }, label: 'name' };

const lensWith = (tagSourceAtPath: unknown): LensNarrowing => ({
  parent: base,
  root: {
    where: { field: 'orgId', operator: 'equals', bind: 'orgId' },
    relations: {
      tagAttachments: {
        where: live,
        relations: { tag: { sources: { id: tagSourceAtPath } } as never },
      },
    },
  },
  mapDefaults: { app: { models: { Tag: { where: live, sources: { id: tagSource } as never } } } },
});

const attachment = (orgId: string, deletedAt: string | null = null) => ({
  deletedAt,
  user: { orgId },
});
const tags: Row[] = [
  { id: 'T1', name: 'a1', ownerId: 'acme', deletedAt: null, attachments: [attachment('acme')] },
  {
    id: 'T2',
    name: 'b2',
    ownerId: 'acme',
    deletedAt: null,
    attachments: [attachment('acme', '2026-01-01')],
  },
  { id: 'T3', name: 'a3', ownerId: 'acme', deletedAt: null, attachments: [] },
  {
    id: 'T4',
    name: 'a4',
    ownerId: 'acme',
    deletedAt: '2026-01-01',
    attachments: [attachment('acme')],
  },
  { id: 'T9', name: 'a9', ownerId: 'globex', deletedAt: null, attachments: [attachment('globex')] },
];

const PATH = 'User.tagAttachments.tag';
const offered = (lens: LensNarrowing): string[] => {
  const query = toSourceQueries(bindLens(lens, { orgId: 'acme' })).find(
    (q) => q.path === PATH && q.field === 'id',
  );
  if (!query) return [];
  return tags
    .filter((tag) => check(query.composedWhere, tag) === true)
    .map((tag) => tag.id as string);
};

describe('a path source offers what its path reaches', () => {
  test('only tags linked through a live attachment of an in-tenant user', () => {
    expect(offered(lensWith(true))).toEqual(['T1']);
  });
});

describe("from: 'mapDefaults' offers the model's own source", () => {
  const pointer = lensWith({ from: 'mapDefaults' });

  test('every live tag the owner owns, linked or not, never another tenant’s', () => {
    expect(offered(pointer)).toEqual(['T1', 'T2', 'T3']);
  });

  test("it takes the model source's label, and projects as a pointer", () => {
    const [visitPath, visit] = Object.entries(projectLens(pointer)).find(([p]) => p === PATH) ?? [];
    expect(visitPath).toBe(PATH);
    expect(visit?.sourceFrom).toEqual({ id: 'mapDefaults' });
    expect(visit?.sourceLabels.id).toBe('name');
    expect(
      toSourceQueries(bindLens(pointer, { orgId: 'acme' })).find((q) => q.path === PATH)?.label,
    ).toBe('name');
  });

  test('its own where, and a child layer, only narrow it', () => {
    expect(
      offered(
        lensWith({
          from: 'mapDefaults',
          where: { field: 'name', operator: 'startsWith', value: 'a' },
        }),
      ),
    ).toEqual(['T1', 'T3']);
    const child: LensNarrowing = {
      parent: pointer,
      mapDefaults: {
        app: {
          models: {
            Tag: { sources: { id: { field: 'name', operator: 'startsWith', value: 'b' } } },
          },
        },
      },
    };
    expect(offered(child)).toEqual(['T2']);
  });

  test('a layer hiding the field drops it, as any source', () => {
    const hides: LensNarrowing = {
      parent: pointer,
      root: { relations: { tagAttachments: { relations: { tag: { omits: ['id'] } } } } },
    };
    expect(toSourceQueries(bindLens(hides, { orgId: 'acme' })).some((q) => q.path === PATH)).toBe(
      false,
    );
  });

  test('an unbound tenancy bind refuses to compile', () => {
    expect(() => toSourceQueries(pointer)).toThrow(/orgId/);
  });

  test('materializeSources refuses it: a fetched collection can’t hold unlinked rows', () => {
    expect(() => materializeSources(bindLens(pointer, { orgId: 'acme' }), [])).toThrow(
      'toSourceQueries and materializeSourceQuery',
    );
  });
});

describe('a pointer escapes only the layer that points: every other layer still narrows it', () => {
  const platform: LensNarrowing = {
    parent: base,
    root: {
      relations: {
        tagAttachments: { relations: { tag: { sources: { id: { from: 'mapDefaults' } } } } },
      },
    } as never,
    mapDefaults: { app: { models: { Tag: { where: live, sources: { id: { label: 'name' } } } } } },
  };
  const tenant: LensNarrowing = {
    parent: platform,
    root: { where: { field: 'orgId', operator: 'equals', value: 'acme' } },
  };

  test('the pointing layer offers every live tag', () => {
    expect(offered(platform)).toEqual(['T1', 'T2', 'T3', 'T9']);
  });

  test("a tenant layer after it narrows its options to the tenant's reach", () => {
    expect(offered(tenant)).toEqual(['T1', 'T2']);
  });

  test('a layer after the tenant still sees the pointer tenanted', () => {
    const later: LensNarrowing = { parent: tenant, root: { omits: ['orgId'] } };
    expect(offered(later)).toEqual(['T1', 'T2']);
  });
});

describe('a pointer must find its model source', () => {
  const undeclared: LensNarrowing = {
    parent: base,
    root: {
      relations: {
        tagAttachments: { relations: { tag: { sources: { name: { from: 'mapDefaults' } } } } },
      },
    },
  };

  test('validateNarrowing reports it, and projecting it throws', () => {
    expect(validateNarrowing(undeclared).errors).toEqual([
      expect.objectContaining({
        code: 'invalid_source',
        path: 'root.relations.tagAttachments.relations.tag.sources.name',
      }),
    ]);
    expect(() => projectLens(undeclared)).toThrow('mapDefaults.app.models.Tag.sources.name');
  });

  test('it lives on a path, names mapDefaults, and takes the label it points at', () => {
    const codes = (narrowing: LensNarrowing) =>
      validateNarrowing(narrowing).errors.map((e) => e.message);
    expect(
      codes({
        parent: base,
        mapDefaults: { app: { models: { Tag: { sources: { id: { from: 'mapDefaults' } } } } } },
      }),
    ).toEqual([expect.stringContaining("it can't point itself")]);
    expect(codes(lensWith({ from: 'elsewhere' }))).toEqual([
      expect.stringContaining("from takes 'mapDefaults'"),
    ]);
    expect(codes(lensWith({ from: 'mapDefaults', label: 'name' }))).toEqual([
      expect.stringContaining('takes the model source'),
    ]);
    expect(() => assertValidNarrowing(lensWith({ from: 'mapDefaults' }))).not.toThrow();
  });
});

describe('across a bridge', () => {
  const crmTenancy = { where: { field: 'kingdomOrgId', operator: 'equals', bind: 'orgId' } };
  const bridged = (atPath: unknown): LensNarrowing => ({
    parent: base,
    root: {
      where: { field: 'orgId', operator: 'equals', bind: 'orgId' },
      relations: { 'crm:Account': { sources: { tier: atPath } } as never },
    },
    mapDefaults: { crm: { models: { Account: { sources: { tier: crmTenancy } as never } } } },
  });
  const query = (lens: LensNarrowing) =>
    toSourceQueries(bindLens(lens, { orgId: 'acme' })).find((q) => q.field === 'tier');
  const accounts: Row[] = [
    { kingdomOrgId: 'acme', tier: 'gold' },
    { kingdomOrgId: 'globex', tier: 'silver' },
  ];

  test("a pointer resolves in the far map's mapDefaults and compiles against that map alone", () => {
    const q = query(bridged({ from: 'mapDefaults' }));
    expect(q?.mapName).toBe('crm');
    expect(q?.sql.sql).not.toContain('JOIN');
    expect(accounts.filter((a) => check(q?.composedWhere ?? false, a) === true)).toEqual([
      accounts[0],
    ]);
  });

  test('a path source across a bridge over-fetches; the clamps above come back as its recheck', () => {
    const lens = bridged(true);
    const q = query(lens);
    if (!q) throw new Error('no query');
    // The far map's own tenancy is the database's to decide; the root clamp reads across the bridge.
    expect(q.prisma).toEqual({
      model: 'Account',
      select: { tier: true, kingdomOrgId: true },
      where: { kingdomOrgId: { equals: 'acme' } },
    });
    expect(q.recheck).toEqual({
      all: [
        { field: 'app:User', operator: 'exists' },
        { field: 'app:User.orgId', operator: 'equals', value: 'acme' },
      ],
    });
    const candidates: Row[] = [
      { tier: 'gold', kingdomOrgId: 'acme', 'app:User': { orgId: 'acme' } },
      { tier: 'bronze', kingdomOrgId: 'acme', 'app:User': null },
    ];
    expect(materializeSourceQuery(q, candidates, { lens }).options).toEqual([{ value: 'gold' }]);
  });
});

describe('a pointer never widens what a parent layer gave', () => {
  // The parent's path source is linked-only and carries its tenancy down; its model source has
  // no tenancy of its own.
  const parent: LensNarrowing = {
    parent: base,
    root: {
      where: { field: 'orgId', operator: 'equals', bind: 'orgId' },
      relations: {
        tagAttachments: { where: live, relations: { tag: { sources: { id: true } } } },
      },
    },
    mapDefaults: { app: { models: { Tag: { sources: { id: true } } } } },
  };
  const child: LensNarrowing = {
    parent,
    root: {
      relations: {
        tagAttachments: { relations: { tag: { sources: { id: { from: 'mapDefaults' } } } } },
      },
    },
  };

  test("a child's pointer still carries the clamps of every layer above it", () => {
    const given = offered(parent);
    expect(given).toEqual(['T1', 'T4']);
    expect(offered(child)).toEqual(given);
    expect(offered(child)).not.toContain('T9');
  });
});

test('a hidden pointer with no model source still throws when projected', () => {
  const hidden: LensNarrowing = {
    parent: base,
    root: {
      relations: {
        tagAttachments: {
          relations: { tag: { omits: ['name'], sources: { name: { from: 'mapDefaults' } } } },
        },
      },
    },
  };
  expect(() => projectLens(hidden)).toThrow('mapDefaults.app.models.Tag.sources.name');
});

test("a child's narrowing of a relation below a pointer still guards the label it reads", () => {
  const labelled: LensNarrowing = {
    parent: base,
    root: {
      relations: {
        tagAttachments: {
          relations: {
            tag: { sources: { id: { from: 'mapDefaults' } }, relations: { org: {} } },
          },
        },
      },
    },
    mapDefaults: { app: { models: { Tag: { sources: { id: { label: 'org.name' } } } } } },
  };
  const child: LensNarrowing = {
    parent: labelled,
    root: {
      relations: {
        tagAttachments: {
          relations: {
            tag: {
              relations: { org: { where: { field: 'secret', operator: 'equals', value: false } } },
            },
          },
        },
      },
    },
  };
  expect(validateNarrowing(child).ok).toBe(true);
  const query = toSourceQueries(child).find((q) => q.path === PATH);
  expect(query?.label).toBe('org.name');
  const rows: Row[] = [
    { id: 'open', org: { name: 'o', secret: false } },
    { id: 'hidden', org: { name: 'h', secret: true } },
  ];
  expect(
    rows.filter((r) => check(query?.composedWhere ?? false, r) === true).map((r) => r.id),
  ).toEqual(['open']);
});
