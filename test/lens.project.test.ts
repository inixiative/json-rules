import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';
import { at } from './fixtures/helpers';

const prismaMap: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
        crmId: { kind: 'scalar', type: 'String' },
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
  cardinality: 'oneToMany',
};

const stitched = stitchFieldMaps({
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges: [bridge],
});

const lens: Lens = {
  ...stitched,
  mapName: 'prisma',
  model: 'FanUser',
};

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('projectByPath', () => {
  test('empty chain returns single root entry with all fields', () => {
    const out = projectByPath(lens);
    expect([...out.keys()]).toEqual(['FanUser']);
    const root = at(out, 'FanUser');
    expect(root.fields.email).toBeDefined();
    expect(root.fields.name).toBeDefined();
  });

  test('picks restrict to listed fields at root', () => {
    const n = withParent(lens, { root: { picks: ['email'] } });
    const out = projectByPath(n);
    const root = at(out, 'FanUser');
    expect(root.fields.email).toBeDefined();
    expect(root.fields.name).toBeUndefined();
    expect(root.fields.deletedAt).toBeUndefined();
  });

  test('omits drop listed fields at root', () => {
    const n = withParent(lens, { root: { omits: ['deletedAt', 'name'] } });
    const out = projectByPath(n);
    const root = at(out, 'FanUser');
    expect(root.fields.email).toBeDefined();
    expect(root.fields.name).toBeUndefined();
    expect(root.fields.deletedAt).toBeUndefined();
  });

  test('picks keep relation fields that have nested narrowings; nested visit narrows the target', () => {
    const n = withParent(lens, {
      root: {
        picks: ['email'],
        relations: { fanMissions: { picks: ['missionUuid'] } },
      },
    });
    const out = projectByPath(n);
    const root = at(out, 'FanUser');
    expect(root.fields.email).toBeDefined();
    expect(root.fields.fanMissions).toBeDefined();
    const nested = at(out, 'FanUser.fanMissions');
    expect(nested.modelName).toBe('FanMission');
    expect(nested.fields.missionUuid).toBeDefined();
    expect(nested.fields.status).toBeUndefined();
    expect(nested.fields.id).toBeUndefined();
  });

  test('cascades through cross-map bridge', () => {
    const n = withParent(lens, {
      root: {
        relations: {
          'salesforce:Contact': { picks: ['industry'] },
        },
      },
    });
    const out = projectByPath(n);
    const bridged = at(out, 'FanUser.salesforce:Contact');
    expect(bridged.mapName).toBe('salesforce');
    expect(bridged.modelName).toBe('Contact');
    expect(bridged.fields.industry).toBeDefined();
    expect(bridged.fields.id).toBeUndefined();
  });

  test('multi-level chain applies all narrowings cumulatively', () => {
    const n1 = withParent(lens, { root: { picks: ['email', 'name', 'id'] } });
    const n2 = withParent(n1, { root: { picks: ['email', 'name'] } });
    const n3 = withParent(n2, { root: { omits: ['name'] } });
    const out = projectByPath(n3);
    const root = at(out, 'FanUser');
    expect(root.fields.email).toBeDefined();
    expect(root.fields.name).toBeUndefined();
    expect(root.fields.id).toBeUndefined();
    expect(root.fields.deletedAt).toBeUndefined();
  });

  test('does not mutate input', () => {
    const n = withParent(lens, { root: { picks: ['email'] } });
    projectByPath(n);
    expect(stitched.maps.prisma.models.FanUser.fields.email).toBeDefined();
    expect(stitched.maps.prisma.models.FanUser.fields.name).toBeDefined();
  });
});
