import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { ArrayOperator, Operator } from '../src/operator';

describe('bridge keys in `path:` value refs', () => {
  test('context path traverses through bridge key', () => {
    const rule = {
      field: 'email',
      operator: Operator.equals,
      path: 'salesforce:Contact.preferredEmail',
    };
    const data = {
      email: 'a@b.com',
      'salesforce:Contact': { preferredEmail: 'a@b.com', industry: 'tech' },
    };
    expect(check(rule, data)).toBe(true);
  });

  test('context path through bidirectional back-ref', () => {
    const fanUser: Record<string, unknown> = { id: 'u1', crmId: 'c1', email: 'a@b.com' };
    const contact: Record<string, unknown> = { id: 'c1', preferredEmail: 'a@b.com' };
    fanUser['salesforce:Contact'] = contact;
    contact['prisma:FanUser'] = fanUser;

    const rule = {
      field: 'email',
      operator: Operator.equals,
      path: 'salesforce:Contact.prisma:FanUser.email',
    };
    expect(check(rule, fanUser)).toBe(true);
  });

  test('`$.` current-element path traverses element bridge key', () => {
    const data = {
      orders: [
        {
          id: 'o1',
          total: 100,
          'salesforce:Contact': { industry: 'tech', priceTier: 100 },
        },
        {
          id: 'o2',
          total: 50,
          'salesforce:Contact': { industry: 'finance', priceTier: 200 },
        },
      ],
    };

    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'total',
        operator: Operator.equals,
        path: '$.salesforce:Contact.priceTier',
      },
    };
    expect(check(rule, data)).toBe(true);
  });

  test('`field:` with bridge segments and `path:` with bridge segments both walk identically', () => {
    const data = {
      'salesforce:Contact': { industry: 'tech', priceTier: 100 },
      otherTier: 100,
    };

    // field: walks data
    expect(
      check(
        {
          field: 'salesforce:Contact.priceTier',
          operator: Operator.equals,
          value: 100,
        },
        data,
      ),
    ).toBe(true);

    // path: walks context (defaults to data) — same answer
    expect(
      check(
        {
          field: 'otherTier',
          operator: Operator.equals,
          path: 'salesforce:Contact.priceTier',
        },
        data,
      ),
    ).toBe(true);
  });

  test('path: returns undefined when bridge key absent (predicate fails cleanly)', () => {
    const rule = {
      field: 'email',
      operator: Operator.equals,
      path: 'salesforce:Contact.preferredEmail',
    };
    const data = { email: 'a@b.com' };
    expect(typeof check(rule, data)).toBe('string');
  });

  test('intermediate object bridge with deeper terminal works', () => {
    const data = {
      x: 'tech',
      'salesforce:Contact': { meta: { industry: 'tech', tier: 100 } },
    };
    expect(
      check(
        { field: 'x', operator: Operator.equals, path: 'salesforce:Contact.meta.industry' },
        data,
      ),
    ).toBe(true);
  });

  test('intermediate ARRAY bridge (1-many) — path: can index by number', () => {
    const data = {
      x: 'launch',
      'crm:MarketingEvent': [
        { id: 'e1', campaign: 'launch' },
        { id: 'e2', campaign: 'retention' },
      ],
    };
    // Numeric index works (lodash.get treats arrays like ordered objects)
    expect(
      check({ field: 'x', operator: Operator.equals, path: 'crm:MarketingEvent.0.campaign' }, data),
    ).toBe(true);
  });

  test('arrayRule iterating a bridge ARRAY: $. on current item with bridge key works', () => {
    const data = {
      'crm:MarketingEvent': [
        { id: 'e1', campaign: 'enterprise', 'billing:Account': { plan: 'enterprise' } },
        { id: 'e2', campaign: 'retention', 'billing:Account': { plan: 'free' } },
      ],
    };
    // For each event: campaign === current event's billing:Account.plan
    const rule = {
      field: 'crm:MarketingEvent',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'campaign',
        operator: Operator.equals,
        path: '$.billing:Account.plan',
      },
    };
    expect(check(rule, data)).toBe(true);
  });

  test('arrayRule iterating bridge ARRAY: condition path: refers to root context via bridge', () => {
    const data = {
      'salesforce:Contact': { preferredCampaign: 'launch' },
      'crm:MarketingEvent': [
        { id: 'e1', campaign: 'launch' },
        { id: 'e2', campaign: 'retention' },
      ],
    };
    // No $. → resolves through root context, which has the bridge
    const rule = {
      field: 'crm:MarketingEvent',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'campaign',
        operator: Operator.equals,
        path: 'salesforce:Contact.preferredCampaign',
      },
    };
    expect(check(rule, data)).toBe(true);
  });

  test('arrayRule with $. and bridge nested in each item', () => {
    const data = {
      orders: [
        { id: 'o1', total: 50, 'salesforce:Contact': { maxBudget: 100 } },
        { id: 'o2', total: 200, 'salesforce:Contact': { maxBudget: 150 } },
      ],
    };
    // Each order's nested bridge accessible via $.
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.all,
      condition: {
        field: 'total',
        operator: Operator.lessThanEquals,
        path: '$.salesforce:Contact.maxBudget',
      },
    };
    expect(typeof check(rule, data)).toBe('string'); // o2.total > maxBudget
  });

  test('arrayRule: $. and context path both reachable through bridges, in same eval', () => {
    const data = {
      currentCampaign: 'launch', // root context
      'salesforce:Contact': { tier: 'enterprise' }, // root bridge
      orders: [
        { id: 'o1', campaign: 'launch', 'billing:Account': { tier: 'enterprise' } },
        { id: 'o2', campaign: 'retention', 'billing:Account': { tier: 'free' } },
      ],
    };
    // For each order: campaign matches root.currentCampaign AND order's nested billing:Account.tier matches root's salesforce:Contact.tier
    expect(
      check(
        {
          field: 'orders',
          arrayOperator: ArrayOperator.any,
          condition: {
            all: [
              { field: 'campaign', operator: Operator.equals, path: 'currentCampaign' },
              {
                field: 'billing:Account.tier',
                operator: Operator.equals,
                path: 'salesforce:Contact.tier',
              },
            ],
          },
        },
        data,
      ),
    ).toBe(true);
  });

  test('intermediate ARRAY bridge — `.field` without index returns undefined (limitation)', () => {
    const data = {
      x: 'launch',
      'crm:MarketingEvent': [
        { id: 'e1', campaign: 'launch' },
        { id: 'e2', campaign: 'retention' },
      ],
    };
    // No index → lodash can't reach into array elements → undefined → predicate fails
    expect(
      typeof check(
        { field: 'x', operator: Operator.equals, path: 'crm:MarketingEvent.campaign' },
        data,
      ),
    ).toBe('string');
  });
});
