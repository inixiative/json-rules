import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import { at } from './fixtures/helpers';

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

// ============================================================
// #1 — Bridges across maps: mapDefaults at bridged visit,
//      bridge → object descent, chained narrowing of bridge path.
// ============================================================

const prismaMap: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        crmId: { kind: 'scalar', type: 'String' },
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
        accountId: { kind: 'scalar', type: 'String' },
        account: { kind: 'object', type: 'Account', isList: false },
      },
    },
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        region: { kind: 'scalar', type: 'String' },
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
const bridgeLens: Lens = {
  ...stitchFieldMaps({ maps: { prisma: prismaMap, salesforce: salesforceMap }, bridges: [bridge] }),
  mapName: 'prisma',
  model: 'FanUser',
};

describe('projectByPath — bridges', () => {
  test('mapDefaults.salesforce.models.Contact applies at the bridged visit', () => {
    const n = withParent(bridgeLens, {
      root: { relations: { 'salesforce:Contact': {} } },
      mapDefaults: {
        salesforce: { models: { Contact: { omits: ['industry'] } } },
      },
    });
    const proj = projectByPath(n);
    const contact = at(proj, 'FanUser.salesforce:Contact');
    expect(contact.mapName).toBe('salesforce');
    expect(contact.modelName).toBe('Contact');
    expect(contact.fields.industry).toBeUndefined();
    expect(contact.fields.id).toBeDefined();
  });

  test('bridge → object descent: Contact.account → Account', () => {
    const n = withParent(bridgeLens, {
      root: {
        relations: {
          'salesforce:Contact': {
            relations: { account: { picks: ['name'] } },
          },
        },
      },
    });
    const proj = projectByPath(n);
    expect([...proj.keys()].sort()).toEqual([
      'FanUser',
      'FanUser.salesforce:Contact',
      'FanUser.salesforce:Contact.account',
    ]);
    const account = at(proj, 'FanUser.salesforce:Contact.account');
    expect(account.mapName).toBe('salesforce');
    expect(account.modelName).toBe('Account');
    expect(Object.keys(account.fields).sort()).toEqual(['name']);
  });

  test('chained narrowing of a bridged path: layer 2 narrows layer 1', () => {
    const n1 = withParent(bridgeLens, {
      root: {
        relations: { 'salesforce:Contact': { picks: ['id', 'industry', 'accountId'] } },
      },
    });
    const n2 = withParent(n1, {
      root: {
        relations: { 'salesforce:Contact': { picks: ['industry'] } },
      },
    });
    const contact = at(projectByPath(n2), 'FanUser.salesforce:Contact');
    expect(Object.keys(contact.fields).sort()).toEqual(['industry']);
  });
});

// ============================================================
// #2 — mapDefaults.models[X].where anchors at EVERY visit of X.
//      Security-adjacent: tenant-scoping `where` must propagate
//      to nested visits, not just the root anchor.
// ============================================================

const multiUserMap: FieldMap = {
  models: {
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        author: { kind: 'object', type: 'User', isList: false },
        editor: { kind: 'object', type: 'User', isList: false },
      },
    },
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        tenantId: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};
const postLens: Lens = { maps: { prisma: multiUserMap }, mapName: 'prisma', model: 'Post' };

describe('projectByPath — mapDefaults.models[X].where anchors at every visit', () => {
  test('tenant-scoping where appears at root AND at every nested visit of the model', () => {
    const tenantScope = {
      field: 'tenantId',
      operator: Operator.equals,
      value: 'tenant-1',
    };
    const n = withParent(postLens, {
      root: {
        relations: {
          author: {},
          editor: {},
        },
      },
      mapDefaults: {
        prisma: { models: { User: { where: tenantScope } } },
      },
    });
    const proj = projectByPath(n);
    // Post root visit: no User defaults apply here (we're on Post).
    expect(at(proj, 'Post').whereClauses).toEqual([]);
    // Both User visits have the tenant scope anchored.
    expect(at(proj, 'Post.author').whereClauses).toContainEqual(tenantScope);
    expect(at(proj, 'Post.editor').whereClauses).toContainEqual(tenantScope);
  });

  test('regression guard: mapDefaults.models.User.where on a path that descends through User twice', () => {
    // Schema needs User → User self-reference. Use a different fixture below.
    const map: FieldMap = {
      models: {
        User: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            tenantId: { kind: 'scalar', type: 'String' },
            manager: { kind: 'object', type: 'User', isList: false },
          },
        },
      },
    };
    const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };
    const tenantScope = { field: 'tenantId', operator: Operator.equals, value: 't1' };
    const n = withParent(lens, {
      root: {
        relations: {
          manager: { relations: { manager: {} } },
        },
      },
      mapDefaults: { prisma: { models: { User: { where: tenantScope } } } },
    });
    const proj = projectByPath(n);
    expect(at(proj, 'User').whereClauses).toContainEqual(tenantScope);
    expect(at(proj, 'User.manager').whereClauses).toContainEqual(tenantScope);
    expect(at(proj, 'User.manager.manager').whereClauses).toContainEqual(tenantScope);
  });
});

// ============================================================
// #3 — Narrowing only at deep position (no root narrowing).
//      Intermediate visits emit all fields; only the deep visit
//      gets the declared picks/omits.
// ============================================================

const deepMap: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
        comments: { kind: 'object', type: 'Comment', isList: true },
      },
    },
    Comment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        body: { kind: 'scalar', type: 'String' },
        flagged: { kind: 'scalar', type: 'Boolean' },
      },
    },
  },
};
const deepLens: Lens = { maps: { prisma: deepMap }, mapName: 'prisma', model: 'User' };

describe('projectByPath — narrowing only at depth', () => {
  test('intermediate visits show all fields; only declared leaf is narrowed', () => {
    const n = withParent(deepLens, {
      root: {
        relations: {
          posts: {
            relations: {
              comments: { picks: ['body'] },
            },
          },
        },
      },
    });
    const proj = projectByPath(n);
    expect(Object.keys(at(proj, 'User').fields).sort()).toEqual(['email', 'id', 'posts']);
    expect(Object.keys(at(proj, 'User.posts').fields).sort()).toEqual(['comments', 'id', 'title']);
    expect(Object.keys(at(proj, 'User.posts.comments').fields).sort()).toEqual(['body']);
  });
});

// ============================================================
// #4 — Direct self-referential relation (single-hop).
//      Each visit independent; walker descends only as deep as
//      narrowing declares.
// ============================================================

const selfRefMap: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        manager: { kind: 'object', type: 'User', isList: false },
      },
    },
  },
};
const selfRefLens: Lens = { maps: { prisma: selfRefMap }, mapName: 'prisma', model: 'User' };

describe('projectByPath — direct self-referential relation', () => {
  test('declared 1 hop deep: only User and User.manager visits exist', () => {
    const n = withParent(selfRefLens, {
      root: { relations: { manager: { picks: ['email'] } } },
    });
    const proj = projectByPath(n);
    expect([...proj.keys()].sort()).toEqual(['User', 'User.manager']);
    expect(Object.keys(at(proj, 'User.manager').fields).sort()).toEqual(['email']);
    expect(proj.get('User.manager.manager')).toBeUndefined();
  });

  test('declared 2 hops deep: each manager visit is independently narrowed', () => {
    const n = withParent(selfRefLens, {
      root: {
        relations: {
          manager: {
            picks: ['name', 'manager'],
            relations: {
              manager: { picks: ['email'] },
            },
          },
        },
      },
    });
    const proj = projectByPath(n);
    expect([...proj.keys()].sort()).toEqual(['User', 'User.manager', 'User.manager.manager']);
    expect(Object.keys(at(proj, 'User.manager').fields).sort()).toEqual(['manager', 'name']);
    expect(Object.keys(at(proj, 'User.manager.manager').fields).sort()).toEqual(['email']);
  });
});

// ============================================================
// #5 — narrowing.root undefined, only mapDefaults.
//      Lens with no path-specific narrowing but with mapDefaults
//      restricting the anchor model: emits a single root visit
//      with mapDefaults applied.
// ============================================================

describe('projectByPath — only mapDefaults, no root narrowing', () => {
  test('root visit reflects mapDefaults; no deeper visits without declared relations', () => {
    const lens: Lens = { maps: { prisma: multiUserMap }, mapName: 'prisma', model: 'User' };
    const n = withParent(lens, {
      mapDefaults: {
        prisma: { models: { User: { omits: ['tenantId', 'deletedAt'] } } },
      },
    });
    const proj = projectByPath(n);
    expect([...proj.keys()]).toEqual(['User']);
    expect(Object.keys(at(proj, 'User').fields).sort()).toEqual(['id', 'name']);
  });
});

// ============================================================
// #6 — Where-clause accumulation across chain layers at one visit.
//      Multiple wheres at the same path should all land in
//      whereClauses[], not just the last one.
// ============================================================

describe('projectByPath — chained where clauses accumulate', () => {
  test('two layers each contribute a where at root; both appear', () => {
    const w1 = { field: 'id', operator: Operator.exists };
    const w2 = { field: 'title', operator: Operator.exists };
    const n1 = withParent(postLens, { root: { where: w1 } });
    const n2 = withParent(n1, { root: { where: w2 } });
    const proj = projectByPath(n2);
    expect(at(proj, 'Post').whereClauses).toEqual([w1, w2]);
  });

  test('mapDefaults.where + path.where both anchor at the same visit', () => {
    const tenantScope = { field: 'tenantId', operator: Operator.equals, value: 't1' };
    const localScope = { field: 'name', operator: Operator.exists };
    const n = withParent(postLens, {
      root: {
        relations: {
          author: { where: localScope },
        },
      },
      mapDefaults: {
        prisma: { models: { User: { where: tenantScope } } },
      },
    });
    const proj = projectByPath(n);
    // Both wheres land at the author visit (one from defaults, one from path).
    expect(at(proj, 'Post.author').whereClauses).toContainEqual(tenantScope);
    expect(at(proj, 'Post.author').whereClauses).toContainEqual(localScope);
    expect(at(proj, 'Post.author').whereClauses).toHaveLength(2);
  });
});
