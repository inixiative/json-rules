import { describe, expect, test } from 'bun:test';
import { buildBridgeDictionary } from '../src/fieldMap/buildBridgeDictionary';
import type { Bridge, FieldMapSet } from '../src/fieldMap/types';
import type { FieldMap } from '../src/toPrisma/types';

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
const crmMap: FieldMap = {
  models: {
    Event: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        userId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const oneToMany: Bridge = {
  endpoints: [
    { fieldMap: 'prisma', model: 'FanUser', on: 'id' },
    { fieldMap: 'crm', model: 'Event', on: 'userId' },
  ],
  cardinality: 'oneToMany',
};

const set: FieldMapSet = { maps: { prisma: prismaMap, crm: crmMap }, bridges: [oneToMany] };

describe('buildBridgeDictionary null join keys', () => {
  test('many-side rows with null `on` are filtered (do not create "null" key)', () => {
    const out = buildBridgeDictionary(set, {
      'prisma:FanUser': [{ id: 'u1' }],
      'crm:Event': [
        { id: 'e1', userId: 'u1' },
        { id: 'e2', userId: null }, // unbound event — must not group under "null"
        { id: 'e3', userId: undefined },
      ],
    });
    // Should ONLY have the valid u1 group, not a 'null' or 'undefined' key
    expect(Object.keys(out.crm.Event.userId)).toEqual(['u1']);
    expect(out.crm.Event.userId.u1).toHaveLength(1);
  });

  test('one-side rows with null `on` already skipped (existing behavior)', () => {
    const out = buildBridgeDictionary(set, {
      'prisma:FanUser': [
        { id: 'u1' },
        { id: null }, // bad row
      ],
      'crm:Event': [{ id: 'e1', userId: 'u1' }],
    });
    expect(Object.keys(out.prisma.FanUser.id)).toEqual(['u1']);
  });
});
