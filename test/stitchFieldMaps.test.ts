import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge, FieldMapSet } from '../src/fieldMap/types';
import type { FieldMap } from '../src/toPrisma/types';

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
      },
    },
  },
};

const oneToManyBridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToMany',
};

const oneToOneBridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToOne',
};

describe('stitchFieldMaps', () => {
  test('empty maps + no bridges returns empty set', () => {
    expect(stitchFieldMaps({ maps: {} })).toEqual({ maps: {}, bridges: undefined });
  });

  test('returns clone with no bridges', () => {
    const set: FieldMapSet = { maps: { prisma: prismaMap } };
    const out = stitchFieldMaps(set);
    expect(out.maps).toEqual(set.maps);
    expect(out).not.toBe(set);
    expect(out.maps.prisma).not.toBe(set.maps.prisma);
  });

  test('does not mutate input maps', () => {
    const set: FieldMapSet = {
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [oneToManyBridge],
    };
    const before = structuredClone(set);
    stitchFieldMaps(set);
    expect(set).toEqual(before);
  });

  test('oneToMany injects list on one side, single on many side', () => {
    const out = stitchFieldMaps({
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [oneToManyBridge],
    });
    expect(out.maps.salesforce.models.Contact.fields['prisma:FanUser']).toEqual({
      kind: 'bridge',
      type: 'prisma:FanUser',
      isList: true,
    });
    expect(out.maps.prisma.models.FanUser.fields['salesforce:Contact']).toEqual({
      kind: 'bridge',
      type: 'salesforce:Contact',
      isList: false,
    });
  });

  test('oneToOne injects single on both sides', () => {
    const out = stitchFieldMaps({
      maps: { prisma: prismaMap, salesforce: salesforceMap },
      bridges: [oneToOneBridge],
    });
    expect(out.maps.salesforce.models.Contact.fields['prisma:FanUser'].isList).toBe(false);
    expect(out.maps.prisma.models.FanUser.fields['salesforce:Contact'].isList).toBe(false);
  });

  test('throws when endpoint fieldMap missing', () => {
    expect(() =>
      stitchFieldMaps({ maps: { prisma: prismaMap }, bridges: [oneToManyBridge] }),
    ).toThrow(/endpoint 'salesforce:Contact' not found/);
  });

  test('throws when endpoint model missing', () => {
    const bridge: Bridge = {
      endpoints: [
        { fieldMap: 'prisma', model: 'Ghost', on: 'id' },
        { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
      ],
      cardinality: 'oneToOne',
    };
    expect(() => stitchFieldMaps({ maps: { prisma: prismaMap }, bridges: [bridge] })).toThrow(
      /endpoint 'prisma:Ghost' not found/,
    );
  });

  test('throws when duplicate bridge between same pair', () => {
    expect(() =>
      stitchFieldMaps({
        maps: { prisma: prismaMap, salesforce: salesforceMap },
        bridges: [oneToManyBridge, oneToManyBridge],
      }),
    ).toThrow(/already injected/);
  });

  test('throws when endpoint has no field for `on`', () => {
    const bridge: Bridge = {
      endpoints: [
        { fieldMap: 'salesforce', model: 'Contact', on: 'GHOST' },
        { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
      ],
      cardinality: 'oneToMany',
    };
    expect(() =>
      stitchFieldMaps({
        maps: { prisma: prismaMap, salesforce: salesforceMap },
        bridges: [bridge],
      }),
    ).toThrow(/has no field 'GHOST' for join/);
  });

  test('throws on self-bridge', () => {
    const bridge: Bridge = {
      endpoints: [
        { fieldMap: 'prisma', model: 'FanUser', on: 'id' },
        { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
      ],
      cardinality: 'oneToOne',
    };
    expect(() => stitchFieldMaps({ maps: { prisma: prismaMap }, bridges: [bridge] })).toThrow(
      /self-bridge/,
    );
  });

  test('injects multiple bridges', () => {
    const accountMap: FieldMap = {
      models: {
        Account: { fields: { id: { kind: 'scalar', type: 'String' } } },
      },
    };
    const bridges: Bridge[] = [
      oneToManyBridge,
      {
        endpoints: [
          { fieldMap: 'salesforce2', model: 'Account', on: 'id' },
          { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
        ],
        cardinality: 'oneToMany',
      },
    ];
    const out = stitchFieldMaps({
      maps: { prisma: prismaMap, salesforce: salesforceMap, salesforce2: accountMap },
      bridges,
    });
    expect(out.maps.prisma.models.FanUser.fields['salesforce:Contact']).toBeDefined();
    expect(out.maps.prisma.models.FanUser.fields['salesforce2:Account']).toBeDefined();
    expect(out.maps.salesforce.models.Contact.fields['prisma:FanUser']).toBeDefined();
    expect(out.maps.salesforce2.models.Account.fields['prisma:FanUser']).toBeDefined();
  });
});
