import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { buildBridgeDictionary } from '../src/fieldMap/buildBridgeDictionary';
import { createLens } from '../src/lens/createLens';
import { ArrayOperator, Operator } from '../src/operator';
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
        accountId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const billingMap: FieldMap = {
  models: {
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        plan: { kind: 'scalar', type: 'String' },
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
        campaign: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

describe('end-to-end: buildBridgeDictionary → embed → check', () => {
  test('1-1 bridge: build index, embed by lookup, check passes', () => {
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

    const fanUsers = [
      { id: 'u1', email: 'a@b.com', crmId: 'c1' },
      { id: 'u2', email: 'd@e.com', crmId: 'c2' },
    ];
    const rawForeign = {
      'salesforce:Contact': [
        { id: 'c1', industry: 'tech' },
        { id: 'c2', industry: 'finance' },
      ],
    };
    const index = buildBridgeDictionary(lens, rawForeign);

    const enriched = fanUsers.map((u) => ({
      ...u,
      'salesforce:Contact': index.salesforce.Contact.id[u.crmId],
    }));

    const rule = {
      field: 'salesforce:Contact.industry',
      operator: Operator.equals,
      value: 'tech',
    };
    // u1 matches, u2 doesn't
    expect(check(rule, enriched[0])).toBe(true);
    expect(typeof check(rule, enriched[1])).toBe('string');
  });

  test('1-many bridge: build index (groupBy on many side), embed array, check arrayOperator', () => {
    const lens = createLens({
      maps: { prisma: prismaMap, crm: crmMap },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'prisma', model: 'FanUser', on: 'id' },
            { fieldMap: 'crm', model: 'MarketingEvent', on: 'userId' },
          ],
          cardinality: 'oneToMany',
        },
      ],
      mapName: 'prisma',
      model: 'FanUser',
    });

    const fanUsers = [
      { id: 'u1', email: 'a@b.com' },
      { id: 'u2', email: 'd@e.com' },
    ];
    const rawForeign = {
      'crm:MarketingEvent': [
        { id: 'e1', userId: 'u1', campaign: 'launch' },
        { id: 'e2', userId: 'u1', campaign: 'retention' },
        { id: 'e3', userId: 'u2', campaign: 'retention' },
      ],
    };
    const index = buildBridgeDictionary(lens, rawForeign);

    const enriched = fanUsers.map((u) => ({
      ...u,
      'crm:MarketingEvent': index.crm.MarketingEvent.userId[u.id] ?? [],
    }));

    const rule = {
      field: 'crm:MarketingEvent',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'campaign', operator: Operator.equals, value: 'launch' },
    };
    // u1 has a launch event, u2 doesn't
    expect(check(rule, enriched[0])).toBe(true);
    expect(typeof check(rule, enriched[1])).toBe('string');
  });

  test('multi-bridge model (Contact on two bridges with different `on` fields): both indexes usable end-to-end', () => {
    const lens = createLens({
      maps: { prisma: prismaMap, salesforce: salesforceMap, billing: billingMap },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
            { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
          ],
          cardinality: 'oneToOne',
        },
        {
          endpoints: [
            { fieldMap: 'billing', model: 'Account', on: 'id' },
            { fieldMap: 'salesforce', model: 'Contact', on: 'accountId' },
          ],
          cardinality: 'oneToOne',
        },
      ],
      mapName: 'prisma',
      model: 'FanUser',
    });

    const fanUser = { id: 'u1', email: 'a@b.com', crmId: 'c1' };
    const rawForeign = {
      'salesforce:Contact': [{ id: 'c1', industry: 'tech', accountId: 'a1' }],
      'billing:Account': [{ id: 'a1', plan: 'enterprise' }],
    };
    const index = buildBridgeDictionary(lens, rawForeign);

    // Contact indexed by both id (used by FanUser→Contact) and accountId (used by Account→Contact)
    expect(index.salesforce.Contact.id.c1).toBeDefined();
    expect(index.salesforce.Contact.accountId.a1).toBeDefined();

    // Caller composes 2-deep: FanUser → Contact → Account
    const contact = index.salesforce.Contact.id[fanUser.crmId] as Record<string, unknown>;
    const account = index.billing.Account.id[contact.accountId as string];
    const enriched = {
      ...fanUser,
      'salesforce:Contact': { ...contact, 'billing:Account': account },
    };

    const rule = {
      all: [
        { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
        {
          field: 'salesforce:Contact.billing:Account.plan',
          operator: Operator.equals,
          value: 'enterprise',
        },
      ],
    };
    expect(check(rule, enriched)).toBe(true);
  });
});
