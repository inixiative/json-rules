import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { projectNarrowing } from '../src/lens/project';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      name: { kind: 'scalar', type: 'String' },
      deletedAt: { kind: 'scalar', type: 'DateTime' },
      fanMissions: { kind: 'object', type: 'FanMission', isList: true },
    },
  },
  FanMission: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      missionUuid: { kind: 'scalar', type: 'String' },
      status: { kind: 'scalar', type: 'String' },
    },
  },
};

const salesforceMap: FieldMap = {
  Contact: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      industry: { kind: 'scalar', type: 'String' },
    },
  },
};

const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact' },
    { fieldMap: 'prisma', model: 'FanUser' },
  ],
  cardinality: 'oneToMany',
};

const stitched = stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [bridge]);

const lens: Lens = {
  map: stitched,
  mapName: 'prisma',
  model: 'FanUser',
};

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

describe('projectNarrowing', () => {
  test('empty chain returns clone of root set', () => {
    const out = projectNarrowing(lens);
    expect(out.prisma.FanUser.fields.email).toBeDefined();
    expect(out.prisma.FanUser.fields.name).toBeDefined();
    expect(out).not.toBe(stitched);
  });

  test('picks restrict to listed fields', () => {
    const n = withParent(lens, {
      prisma: { models: { FanUser: { picks: ['email'] } } },
    });
    const out = projectNarrowing(n);
    expect(out.prisma.FanUser.fields.email).toBeDefined();
    expect(out.prisma.FanUser.fields.name).toBeUndefined();
    expect(out.prisma.FanUser.fields.deletedAt).toBeUndefined();
  });

  test('omits drop listed fields', () => {
    const n = withParent(lens, {
      prisma: { models: { FanUser: { omits: ['deletedAt', 'name'] } } },
    });
    const out = projectNarrowing(n);
    expect(out.prisma.FanUser.fields.email).toBeDefined();
    expect(out.prisma.FanUser.fields.name).toBeUndefined();
    expect(out.prisma.FanUser.fields.deletedAt).toBeUndefined();
  });

  test('picks keep relation fields that have nested narrowings', () => {
    const n = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            picks: ['email'],
            relations: { fanMissions: { picks: ['missionUuid'] } },
          },
        },
      },
    });
    const out = projectNarrowing(n);
    expect(out.prisma.FanUser.fields.email).toBeDefined();
    expect(out.prisma.FanUser.fields.fanMissions).toBeDefined();
    expect(out.prisma.FanMission.fields.missionUuid).toBeDefined();
    expect(out.prisma.FanMission.fields.status).toBeUndefined();
    expect(out.prisma.FanMission.fields.id).toBeUndefined();
  });

  test('cascades through cross-map bridge', () => {
    const n = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            relations: {
              'salesforce:Contact': { picks: ['industry'] },
            },
          },
        },
      },
    });
    const out = projectNarrowing(n);
    expect(out.salesforce.Contact.fields.industry).toBeDefined();
    expect(out.salesforce.Contact.fields.id).toBeUndefined();
  });

  test('multi-level chain applies all narrowings cumulatively', () => {
    const n1 = withParent(lens, {
      prisma: { models: { FanUser: { picks: ['email', 'name', 'id'] } } },
    });
    const n2 = withParent(n1, {
      prisma: { models: { FanUser: { picks: ['email', 'name'] } } },
    });
    const n3 = withParent(n2, {
      prisma: { models: { FanUser: { omits: ['name'] } } },
    });
    const out = projectNarrowing(n3);
    expect(out.prisma.FanUser.fields.email).toBeDefined();
    expect(out.prisma.FanUser.fields.name).toBeUndefined();
    expect(out.prisma.FanUser.fields.id).toBeUndefined();
    expect(out.prisma.FanUser.fields.deletedAt).toBeUndefined();
  });

  test('does not mutate input', () => {
    const n = withParent(lens, {
      prisma: { models: { FanUser: { picks: ['email'] } } },
    });
    projectNarrowing(n);
    expect(stitched.prisma.FanUser.fields.email).toBeDefined();
    expect(stitched.prisma.FanUser.fields.name).toBeDefined();
  });
});
