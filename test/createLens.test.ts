import { describe, expect, test } from 'bun:test';
import { createLens } from '../src/lens/createLens';
import type { FieldMap } from '../src/toPrisma/types';

const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      crmId: { kind: 'scalar', type: 'String' },
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

describe('createLens', () => {
  test('single map, no bridges', () => {
    const lens = createLens({
      maps: { prisma: prismaMap },
      mapName: 'prisma',
      model: 'FanUser',
    });
    expect(lens.mapName).toBe('prisma');
    expect(lens.model).toBe('FanUser');
    expect(lens.maps.prisma.FanUser).toBeDefined();
    expect(lens.bridges).toBeUndefined();
  });

  test('multi-map + bridges → auto-stitched', () => {
    const lens = createLens({
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
            { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
          ],
          cardinality: 'oneToOne',
        },
      ],
      mapName: 'prisma',
      model: 'FanUser',
    });
    expect(lens.maps.prisma.FanUser.fields['salesforce:Contact']).toEqual({
      kind: 'bridge',
      type: 'salesforce:Contact',
      isList: false,
    });
    expect(lens.maps.salesforce.Contact.fields['prisma:FanUser']).toEqual({
      kind: 'bridge',
      type: 'prisma:FanUser',
      isList: false,
    });
    expect(lens.bridges).toHaveLength(1);
  });

  test('does not mutate input maps', () => {
    const before = structuredClone(prismaMap);
    createLens({
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
            { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
          ],
          cardinality: 'oneToOne',
        },
      ],
      mapName: 'prisma',
      model: 'FanUser',
    });
    expect(prismaMap).toEqual(before);
  });
});
