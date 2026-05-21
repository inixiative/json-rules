import { describe, expect, test } from 'bun:test';
import { buildBridgeIndex } from '../src/fieldMap/buildBridgeIndex';
import type { Bridge, FieldMapSet } from '../src/fieldMap/types';
import type { FieldMap } from '../src/toPrisma/types';

const prismaMap: FieldMap = {
  FanUser: {
    fields: { id: { kind: 'scalar', type: 'String' }, crmId: { kind: 'scalar', type: 'String' } },
  },
};
const salesforceMap: FieldMap = {
  Contact: { fields: { id: { kind: 'scalar', type: 'String' } } },
};
const crmMap: FieldMap = {
  MarketingEvent: {
    fields: { id: { kind: 'scalar', type: 'String' }, userId: { kind: 'scalar', type: 'String' } },
  },
};

const oneToOne: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToOne',
};

const oneToMany: Bridge = {
  endpoints: [
    { fieldMap: 'prisma', model: 'FanUser', on: 'id' },
    { fieldMap: 'crm', model: 'MarketingEvent', on: 'userId' },
  ],
  cardinality: 'oneToMany',
};

const oneToOneSet: FieldMapSet = {
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges: [oneToOne],
};

const oneToManySet: FieldMapSet = {
  maps: { prisma: prismaMap, crm: crmMap },
  bridges: [oneToMany],
};

const bothSet: FieldMapSet = {
  maps: { prisma: prismaMap, salesforce: salesforceMap, crm: crmMap },
  bridges: [oneToOne, oneToMany],
};

describe('buildBridgeIndex', () => {
  test('keys 1-1 endpoints by their on field', () => {
    const out = buildBridgeIndex(oneToOneSet, {
      'salesforce:Contact': [
        { id: 'c1', industry: 'tech' },
        { id: 'c2', industry: 'finance' },
      ],
      'prisma:FanUser': [
        { crmId: 'c1', email: 'a@b.com' },
        { crmId: 'c2', email: 'd@e.com' },
      ],
    });
    expect(out['salesforce:Contact'].c1).toEqual({ id: 'c1', industry: 'tech' });
    expect(out['prisma:FanUser'].c1).toEqual({ crmId: 'c1', email: 'a@b.com' });
  });

  test('1-many: "one" side keyed singular, "many" side grouped to arrays', () => {
    const out = buildBridgeIndex(oneToManySet, {
      'prisma:FanUser': [
        { id: 'u1', email: 'a@b.com' },
        { id: 'u2', email: 'd@e.com' },
      ],
      'crm:MarketingEvent': [
        { id: 'e1', userId: 'u1', campaign: 'launch' },
        { id: 'e2', userId: 'u1', campaign: 'retention' },
        { id: 'e3', userId: 'u2', campaign: 'launch' },
      ],
    });
    expect(out['prisma:FanUser'].u1).toEqual({ id: 'u1', email: 'a@b.com' });
    expect(out['crm:MarketingEvent'].u1).toHaveLength(2);
    expect(out['crm:MarketingEvent'].u2).toHaveLength(1);
  });

  test('skips endpoints with no raw data provided', () => {
    const out = buildBridgeIndex(oneToOneSet, {
      'salesforce:Contact': [{ id: 'c1', industry: 'tech' }],
    });
    expect(out['salesforce:Contact']).toBeDefined();
    expect(out['prisma:FanUser']).toBeUndefined();
  });

  test('handles multiple bridges in one call', () => {
    const out = buildBridgeIndex(bothSet, {
      'salesforce:Contact': [{ id: 'c1' }],
      'prisma:FanUser': [{ id: 'u1', crmId: 'c1' }],
      'crm:MarketingEvent': [{ id: 'e1', userId: 'u1' }],
    });
    expect(out['salesforce:Contact'].c1).toBeDefined();
    expect(out['crm:MarketingEvent'].u1).toHaveLength(1);
  });

  test('no bridges returns empty index', () => {
    expect(buildBridgeIndex({ maps: {} }, { foo: [{ id: '1' }] })).toEqual({});
  });
});
