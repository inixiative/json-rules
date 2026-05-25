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
const salesforceMap: FieldMap = {
  models: {
    Contact: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        accountId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const billingMap: FieldMap = {
  models: {
    Account: { fields: { id: { kind: 'scalar', type: 'String' } } },
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

describe('buildBridgeDictionary', () => {
  test('keys 1-1 endpoints under map → model → on', () => {
    const out = buildBridgeDictionary(oneToOneSet, {
      'salesforce:Contact': [
        { id: 'c1', industry: 'tech' },
        { id: 'c2', industry: 'finance' },
      ],
      'prisma:FanUser': [
        { crmId: 'c1', email: 'a@b.com' },
        { crmId: 'c2', email: 'd@e.com' },
      ],
    });
    expect(out.salesforce.Contact.id.c1).toEqual({ id: 'c1', industry: 'tech' });
    expect(out.prisma.FanUser.crmId.c1).toEqual({ crmId: 'c1', email: 'a@b.com' });
  });

  test('1-many: "one" side keyed singular, "many" side grouped to arrays', () => {
    const out = buildBridgeDictionary(oneToManySet, {
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
    expect(out.prisma.FanUser.id.u1).toEqual({ id: 'u1', email: 'a@b.com' });
    expect(out.crm.MarketingEvent.userId.u1).toHaveLength(2);
    expect(out.crm.MarketingEvent.userId.u2).toHaveLength(1);
  });

  test('same model on multiple bridges with different `on` fields keeps both indexes', () => {
    const contactToAccount: Bridge = {
      endpoints: [
        { fieldMap: 'billing', model: 'Account', on: 'id' },
        { fieldMap: 'salesforce', model: 'Contact', on: 'accountId' },
      ],
      cardinality: 'oneToOne',
    };
    const set: FieldMapSet = {
      maps: { prisma: prismaMap, salesforce: salesforceMap, billing: billingMap },
      bridges: [oneToOne, contactToAccount],
    };
    const out = buildBridgeDictionary(set, {
      'salesforce:Contact': [
        { id: 'c1', accountId: 'a1' },
        { id: 'c2', accountId: 'a2' },
      ],
      'billing:Account': [{ id: 'a1' }, { id: 'a2' }],
    });
    expect(out.salesforce.Contact.id.c1).toEqual({ id: 'c1', accountId: 'a1' });
    expect(out.salesforce.Contact.accountId.a1).toEqual({ id: 'c1', accountId: 'a1' });
    expect(out.billing.Account.id.a1).toBeDefined();
  });

  test('skips endpoints with no raw data provided', () => {
    const out = buildBridgeDictionary(oneToOneSet, {
      'salesforce:Contact': [{ id: 'c1' }],
    });
    expect(out.salesforce.Contact.id.c1).toBeDefined();
    expect(out.prisma).toBeUndefined();
  });

  test('no bridges returns empty index', () => {
    expect(buildBridgeDictionary({ maps: {} }, { foo: [{ id: '1' }] })).toEqual({});
  });
});
