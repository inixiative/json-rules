import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge, FieldMapSet } from '../src/fieldMap/types';
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

const oneToManyBridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact' },
    { fieldMap: 'prisma', model: 'FanUser' },
  ],
  cardinality: 'oneToMany',
};

const oneToOneBridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact' },
    { fieldMap: 'prisma', model: 'FanUser' },
  ],
  cardinality: 'oneToOne',
};

describe('stitchFieldMaps', () => {
  test('empty set + empty bridges returns empty set', () => {
    expect(stitchFieldMaps({}, [])).toEqual({});
  });

  test('returns clone with no bridges', () => {
    const set: FieldMapSet = { prisma: prismaMap };
    const out = stitchFieldMaps(set, []);
    expect(out).toEqual(set);
    expect(out).not.toBe(set);
    expect(out.prisma).not.toBe(set.prisma);
  });

  test('does not mutate input', () => {
    const set: FieldMapSet = { prisma: prismaMap, salesforce: salesforceMap };
    const before = structuredClone(set);
    stitchFieldMaps(set, [oneToManyBridge]);
    expect(set).toEqual(before);
  });

  test('oneToMany injects list on one side, single on many side', () => {
    const out = stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [
      oneToManyBridge,
    ]);
    expect(out.salesforce.Contact.fields['prisma:FanUser']).toEqual({
      kind: 'bridge',
      type: 'prisma:FanUser',
      isList: true,
    });
    expect(out.prisma.FanUser.fields['salesforce:Contact']).toEqual({
      kind: 'bridge',
      type: 'salesforce:Contact',
      isList: false,
    });
  });

  test('oneToOne injects single on both sides', () => {
    const out = stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [oneToOneBridge]);
    expect(out.salesforce.Contact.fields['prisma:FanUser'].isList).toBe(false);
    expect(out.prisma.FanUser.fields['salesforce:Contact'].isList).toBe(false);
  });

  test('throws when endpoint fieldMap missing', () => {
    expect(() => stitchFieldMaps({ prisma: prismaMap }, [oneToManyBridge])).toThrow(
      /endpoint 'salesforce:Contact' not found/,
    );
  });

  test('throws when endpoint model missing', () => {
    const bridge: Bridge = {
      endpoints: [
        { fieldMap: 'prisma', model: 'Ghost' },
        { fieldMap: 'prisma', model: 'FanUser' },
      ],
      cardinality: 'oneToOne',
    };
    expect(() => stitchFieldMaps({ prisma: prismaMap }, [bridge])).toThrow(
      /endpoint 'prisma:Ghost' not found/,
    );
  });

  test('throws when duplicate bridge between same pair', () => {
    expect(() =>
      stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [
        oneToManyBridge,
        oneToManyBridge,
      ]),
    ).toThrow(/already injected/);
  });

  test('injects multiple bridges', () => {
    const accountMap: FieldMap = {
      Account: { fields: { id: { kind: 'scalar', type: 'String' } } },
    };
    const bridges: Bridge[] = [
      oneToManyBridge,
      {
        endpoints: [
          { fieldMap: 'salesforce2', model: 'Account' },
          { fieldMap: 'prisma', model: 'FanUser' },
        ],
        cardinality: 'oneToMany',
      },
    ];
    const out = stitchFieldMaps(
      { prisma: prismaMap, salesforce: salesforceMap, salesforce2: accountMap },
      bridges,
    );
    expect(out.prisma.FanUser.fields['salesforce:Contact']).toBeDefined();
    expect(out.prisma.FanUser.fields['salesforce2:Account']).toBeDefined();
    expect(out.salesforce.Contact.fields['prisma:FanUser']).toBeDefined();
    expect(out.salesforce2.Account.fields['prisma:FanUser']).toBeDefined();
  });
});
