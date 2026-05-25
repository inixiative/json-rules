import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import type { Lens } from '../src/lens/types';
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
        companyName: { kind: 'scalar', type: 'String' },
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
        cost: { kind: 'scalar', type: 'Int' },
      },
    },
  },
};

const oneToOneContactBridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToOne',
};

const oneToManyEventsBridge: Bridge = {
  endpoints: [
    { fieldMap: 'prisma', model: 'FanUser', on: 'id' },
    { fieldMap: 'crm', model: 'MarketingEvent', on: 'userId' },
  ],
  cardinality: 'oneToMany',
};

const stitched = stitchFieldMaps({
  maps: { prisma: prismaMap, salesforce: salesforceMap, crm: crmMap },
  bridges: [oneToOneContactBridge, oneToManyEventsBridge],
});

const lens: Lens = {
  ...stitched,
  mapName: 'prisma',
  model: 'FanUser',
};

describe('bridge eval — 1-1 (single foreign object)', () => {
  const rule = {
    field: 'salesforce:Contact.industry',
    operator: Operator.equals,
    value: 'tech',
  };

  test('matches when hydrated foreign object satisfies predicate', () => {
    const ctx = {
      id: 'u1',
      crmId: 'c1',
      'salesforce:Contact': { id: 'c1', industry: 'tech', companyName: 'Acme' },
    };
    expect(check(rule, ctx)).toBe(true);
  });

  test('fails when hydrated foreign object does not satisfy', () => {
    const ctx = {
      id: 'u1',
      crmId: 'c1',
      'salesforce:Contact': { id: 'c1', industry: 'finance', companyName: 'Acme' },
    };
    expect(typeof check(rule, ctx)).toBe('string');
  });

  test('fails gracefully when hydrated foreign object missing', () => {
    const ctx = { id: 'u1', crmId: 'c1' };
    expect(typeof check(rule, ctx)).toBe('string');
  });
});

describe('bridge eval — 1-many (foreign array)', () => {
  const anyHighCostRule = {
    field: 'crm:MarketingEvent',
    arrayOperator: ArrayOperator.any,
    condition: { field: 'cost', operator: Operator.greaterThan, value: 100 },
  };

  const allLaunchCampaignRule = {
    field: 'crm:MarketingEvent',
    arrayOperator: ArrayOperator.all,
    condition: { field: 'campaign', operator: Operator.equals, value: 'launch' },
  };

  test('any matches when at least one foreign row satisfies', () => {
    const ctx = {
      id: 'u1',
      'crm:MarketingEvent': [
        { id: 'e1', userId: 'u1', campaign: 'launch', cost: 50 },
        { id: 'e2', userId: 'u1', campaign: 'retention', cost: 200 },
      ],
    };
    expect(check(anyHighCostRule, ctx)).toBe(true);
  });

  test('any fails when no foreign row satisfies', () => {
    const ctx = {
      id: 'u1',
      'crm:MarketingEvent': [
        { id: 'e1', userId: 'u1', campaign: 'launch', cost: 50 },
        { id: 'e2', userId: 'u1', campaign: 'retention', cost: 80 },
      ],
    };
    expect(typeof check(anyHighCostRule, ctx)).toBe('string');
  });

  test('all matches when every foreign row satisfies', () => {
    const ctx = {
      id: 'u1',
      'crm:MarketingEvent': [
        { id: 'e1', userId: 'u1', campaign: 'launch', cost: 50 },
        { id: 'e2', userId: 'u1', campaign: 'launch', cost: 200 },
      ],
    };
    expect(check(allLaunchCampaignRule, ctx)).toBe(true);
  });

  test('all fails when one foreign row violates', () => {
    const ctx = {
      id: 'u1',
      'crm:MarketingEvent': [
        { id: 'e1', userId: 'u1', campaign: 'launch', cost: 50 },
        { id: 'e2', userId: 'u1', campaign: 'retention', cost: 200 },
      ],
    };
    expect(typeof check(allLaunchCampaignRule, ctx)).toBe('string');
  });
});

describe('bridge eval — differentiated relations in same rule', () => {
  // Two distinct bridges (1-1 to Contact, 1-many to MarketingEvent), AND'd
  // The engine must keep them straight via the path keys (salesforce:Contact vs crm:MarketingEvent)
  const rule = {
    all: [
      { field: 'email', operator: Operator.equals, value: 'a@b.com' },
      { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'tech' },
      {
        field: 'crm:MarketingEvent',
        arrayOperator: ArrayOperator.any,
        condition: { field: 'campaign', operator: Operator.equals, value: 'launch' },
      },
    ],
  };

  test('all three predicates satisfied across both bridges', () => {
    const ctx = {
      id: 'u1',
      email: 'a@b.com',
      crmId: 'c1',
      'salesforce:Contact': { id: 'c1', industry: 'tech' },
      'crm:MarketingEvent': [{ id: 'e1', userId: 'u1', campaign: 'launch', cost: 100 }],
    };
    expect(check(rule, ctx)).toBe(true);
  });

  test('only one bridge satisfies → fails (cross-bridge AND distinguishes paths)', () => {
    const ctx = {
      id: 'u1',
      email: 'a@b.com',
      crmId: 'c1',
      'salesforce:Contact': { id: 'c1', industry: 'tech' },
      'crm:MarketingEvent': [{ id: 'e1', userId: 'u1', campaign: 'retention', cost: 100 }],
    };
    expect(typeof check(rule, ctx)).toBe('string');
  });

  test('local-only predicate fails even when both bridges satisfy', () => {
    const ctx = {
      id: 'u1',
      email: 'wrong@b.com',
      crmId: 'c1',
      'salesforce:Contact': { id: 'c1', industry: 'tech' },
      'crm:MarketingEvent': [{ id: 'e1', userId: 'u1', campaign: 'launch', cost: 100 }],
    };
    expect(typeof check(rule, ctx)).toBe('string');
  });
});

describe('bridge schema — on fields are reachable for callers', () => {
  test('stitched set retains bridges array with on fields', () => {
    expect(stitched.bridges).toBeDefined();
    expect(stitched.bridges).toHaveLength(2);
    const oneToOne = stitched.bridges?.find((b) => b.cardinality === 'oneToOne');
    expect(oneToOne?.endpoints[0].on).toBe('id');
    expect(oneToOne?.endpoints[1].on).toBe('crmId');
    const oneToMany = stitched.bridges?.find((b) => b.cardinality === 'oneToMany');
    expect(oneToMany?.endpoints[0].on).toBe('id');
    expect(oneToMany?.endpoints[1].on).toBe('userId');
  });

  test('lens carries the stitched set, including bridges metadata', () => {
    expect(lens.bridges).toBeDefined();
    expect(lens.maps.prisma.models.FanUser.fields['salesforce:Contact']).toBeDefined();
    expect(lens.maps.prisma.models.FanUser.fields['crm:MarketingEvent']).toBeDefined();
  });
});
