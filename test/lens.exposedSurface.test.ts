import { describe, expect, test } from 'bun:test';
import type { FieldMap, LensNarrowing } from '../index';
import { createLens, exposedSurface, Operator } from '../index';

const socialMap: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        password: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        orgs: { kind: 'object', type: 'Org', isList: true },
      },
    },
    Org: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        members: { kind: 'object', type: 'User', isList: true },
        secrets: { kind: 'object', type: 'OrgSecret', isList: true },
      },
    },
    OrgSecret: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        value: { kind: 'scalar', type: 'String' },
      },
    },
    Unreferenced: {
      fields: { id: { kind: 'scalar', type: 'String' } },
    },
  },
  enums: {
    UserRole: ['admin', 'member', 'guest'],
    Unused: ['x', 'y'],
  },
};

describe('exposedSurface — reachability', () => {
  test('keeps the entrypoint and all reachable models, drops unreachable ones', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const reduced = exposedSurface(lens);

    expect(reduced.mapName).toBe('app');
    expect(reduced.model).toBe('User');
    expect(Object.keys(reduced.maps.app.models).sort()).toEqual(['Org', 'OrgSecret', 'User']);
    expect(reduced.maps.app.models.Unreferenced).toBeUndefined();
  });

  test('prunes the enum registry to enum types still referenced by a visible field', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const reduced = exposedSurface(lens);
    expect(reduced.maps.app.enums?.UserRole).toEqual(['admin', 'member', 'guest']);
    expect(reduced.maps.app.enums?.Unused).toBeUndefined();
  });

  test('is cycle-safe — User → Org → members(User) → orgs(Org) terminates', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const reduced = exposedSurface(lens);
    // Org.members points back to User, User.orgs points back to Org — both kept once.
    expect(reduced.maps.app.models.Org.fields.members.type).toBe('User');
    expect(reduced.maps.app.models.User.fields.orgs.type).toBe('Org');
  });
});

describe('exposedSurface — model-default narrowing applied', () => {
  test('omitting a field removes it and severs any models only reachable through it', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        app: {
          models: {
            User: { omits: ['password'] },
            Org: { omits: ['secrets'] }, // the only edge to OrgSecret
          },
        },
      },
    };
    const reduced = exposedSurface(narrowing);

    expect(reduced.maps.app.models.User.fields.password).toBeUndefined();
    expect(reduced.maps.app.models.Org.fields.secrets).toBeUndefined();
    // OrgSecret is now unreachable → pruned out of the mapset entirely.
    expect(reduced.maps.app.models.OrgSecret).toBeUndefined();
  });

  test('enum narrowing is baked onto the field values', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: { app: { models: { User: { enumOmits: { role: ['guest'] } } } } },
    };
    const reduced = exposedSurface(narrowing);
    expect(reduced.maps.app.models.User.fields.role.values).toEqual(['admin', 'member']);
  });

  test('does not throw on a where clause and ignores it for the schema surface', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        app: { models: { User: { where: { field: 'id', operator: Operator.notEmpty } } } },
      },
    };
    const reduced = exposedSurface(narrowing);
    expect(reduced.maps.app.models.User.fields.id).toBeDefined();
  });
});

describe('exposedSurface — multi-source bridges', () => {
  const prismaMap: FieldMap = {
    models: {
      FanUser: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
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
        },
      },
      Lead: {
        fields: { id: { kind: 'scalar', type: 'String' } },
      },
    },
  };

  test('keeps bridges whose endpoints are both reachable and drops models with no edge in', () => {
    const lens = createLens({
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
            { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
          ],
          cardinality: 'oneToMany',
        },
      ],
      mapName: 'prisma',
      model: 'FanUser',
    });
    const reduced = exposedSurface(lens);

    expect(reduced.maps.prisma.models.FanUser).toBeDefined();
    expect(reduced.maps.salesforce.models.Contact).toBeDefined();
    // Lead has no bridge or relation reaching it from FanUser → pruned.
    expect(reduced.maps.salesforce.models.Lead).toBeUndefined();
    expect(reduced.bridges?.length).toBe(1);
  });

  test('eliminates a bridge that touches unexposed surface (no surviving bridge field)', () => {
    // FanUser bridges to Contact directly, and Org bridges to Contact too — so
    // Contact stays reachable via Org even if FanUser's bridge fields are omitted.
    const prisma: FieldMap = {
      models: {
        FanUser: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            crmId: { kind: 'scalar', type: 'String' },
            org: { kind: 'object', type: 'Org' },
          },
        },
        Org: {
          fields: {
            id: { kind: 'scalar', type: 'String' },
            sfId: { kind: 'scalar', type: 'String' },
          },
        },
      },
    };
    const sf: FieldMap = {
      models: { Contact: { fields: { id: { kind: 'scalar', type: 'String' } } } },
    };
    const lens = createLens({
      maps: { prisma, salesforce: sf },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
            { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
          ],
          cardinality: 'oneToMany',
        },
        {
          endpoints: [
            { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
            { fieldMap: 'prisma', model: 'Org', on: 'sfId' },
          ],
          cardinality: 'oneToMany',
        },
      ],
      mapName: 'prisma',
      model: 'FanUser',
    });
    // Omit BOTH of the FanUser↔Contact bridge's injected fields. Contact is still
    // reachable via Org's bridge, so both endpoint models survive — but the
    // FanUser↔Contact bridge now has no surviving field and must be dropped.
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        prisma: { models: { FanUser: { omits: ['salesforce:Contact'] } } },
        salesforce: { models: { Contact: { omits: ['prisma:FanUser'] } } },
      },
    };
    const reduced = exposedSurface(narrowing);

    expect(reduced.maps.salesforce.models.Contact).toBeDefined(); // still reachable via Org
    // Only the Org↔Contact bridge survives; the FanUser↔Contact bridge is eliminated.
    expect(reduced.bridges?.length).toBe(1);
    const survivor = reduced.bridges?.[0];
    expect(survivor?.endpoints.some((e) => e.model === 'Org')).toBe(true);
    expect(survivor?.endpoints.some((e) => e.model === 'FanUser')).toBe(false);
  });
});

describe('exposedSurface — root narrowing must not leak (server→client surface)', () => {
  // Anchor with NO inbound edge: User → posts → Post, Post does not point back.
  const acyclicMap: FieldMap = {
    models: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          email: { kind: 'scalar', type: 'String' },
          password: { kind: 'scalar', type: 'String' },
          posts: { kind: 'object', type: 'Post', isList: true },
        },
      },
      Post: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          title: { kind: 'scalar', type: 'String' },
        },
      },
    },
  };

  test('root omit at the anchor hides the field (no other path exposes it)', () => {
    const lens = createLens({ maps: { app: acyclicMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = { parent: lens, root: { omits: ['password'] } };
    const reduced = exposedSurface(narrowing);
    expect(reduced.maps.app.models.User.fields.password).toBeUndefined();
    expect(reduced.maps.app.models.User.fields.email).toBeDefined();
  });

  test('root picks at the anchor expose only the allow-list', () => {
    const lens = createLens({ maps: { app: acyclicMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = { parent: lens, root: { picks: ['email', 'posts'] } };
    const reduced = exposedSurface(narrowing);
    expect(Object.keys(reduced.maps.app.models.User.fields).sort()).toEqual(['email', 'posts']);
    expect(reduced.maps.app.models.Post).toBeDefined(); // posts kept → Post reachable
  });

  test('union: a field root-hidden at the anchor still appears if another path exposes it', () => {
    // User cycles back via Org.members, where no narrowing hides password.
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = { parent: lens, root: { omits: ['password'] } };
    const reduced = exposedSurface(narrowing);
    // Anchor hides password, but Org.members(User) exposes it → it is legitimately
    // in the total exposed surface. Per-path enforcement is artifact #2's job.
    expect(reduced.maps.app.models.User.fields.password).toBeDefined();
  });
});

describe('exposedSurface — enum registry reflects narrowing (no stale values)', () => {
  test('mapDefaults enum narrowing is reflected in the emitted registry, not just field.values', () => {
    const lens = createLens({ maps: { app: socialMap }, mapName: 'app', model: 'User' });
    const narrowing: LensNarrowing = {
      parent: lens,
      mapDefaults: { app: { enums: { UserRole: { omits: ['guest'] } } } },
    };
    const reduced = exposedSurface(narrowing);
    expect(reduced.maps.app.models.User.fields.role.values).toEqual(['admin', 'member']);
    // The registry must NOT still list the narrowed-away 'guest'.
    expect(reduced.maps.app.enums?.UserRole).toEqual(['admin', 'member']);
  });
});
