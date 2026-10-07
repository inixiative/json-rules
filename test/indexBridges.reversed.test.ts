import { describe, expect, test } from 'bun:test';
import { indexBridges } from '../src/fieldMap/indexBridges';
import type { Bridge, FieldMap, FieldMapSet } from '../src/fieldMap/types';

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
    MarketingEvent: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        userId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

// Reversed convention: many side (MarketingEvent) at endpoint[0], one side at endpoint[1].
// Documented convention is endpoint[0] = "one" side. With duplicates on endpoint[0]'s
// `on` field, keyBy would silently dedup — we want a loud failure instead.
const reversed: Bridge = {
  endpoints: [
    { fieldMap: 'crm', model: 'MarketingEvent', on: 'userId' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'id' },
  ],
  cardinality: 'oneToMany',
};

const set: FieldMapSet = { maps: { prisma: prismaMap, crm: crmMap }, bridges: [reversed] };

describe('indexBridges reversed-endpoint detection', () => {
  test('throws when endpoint[0] rows have duplicate `on` values (silent dedup risk)', () => {
    expect(() =>
      indexBridges(set, {
        'crm:MarketingEvent': [
          { id: 'e1', userId: 'u1' }, // same userId across two rows — keyBy would dedup
          { id: 'e2', userId: 'u1' },
        ],
        'prisma:FanUser': [{ id: 'u1', crmId: 'c1' }],
      }),
    ).toThrow(/duplicate/i);
  });

  test('does not throw when endpoint[0] rows are unique on `on`', () => {
    // Even with reversed convention, if data happens not to collide, no harm done.
    expect(() =>
      indexBridges(set, {
        'crm:MarketingEvent': [
          { id: 'e1', userId: 'u1' },
          { id: 'e2', userId: 'u2' },
        ],
        'prisma:FanUser': [{ id: 'u1' }, { id: 'u2' }],
      }),
    ).not.toThrow();
  });
});
