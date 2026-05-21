import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { createLens } from '../src/lens/createLens';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  User: {
    fields: { id: { kind: 'scalar', type: 'String' } },
  },
};

const lens = createLens({
  maps: { prisma: map },
  mapName: 'prisma',
  model: 'User',
});

describe('check options propagate through recursion', () => {
  test('context is preserved through `all` and resolves path: refs deep', () => {
    const ctx = { threshold: 50 };
    const data = { orders: [{ total: 100 }, { total: 30 }] };
    const rule = {
      all: [
        {
          field: 'orders',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'total', operator: Operator.greaterThan, path: 'threshold' },
        },
      ],
    };
    expect(check(rule, data, { context: ctx })).toBe(true);
  });

  test('context preserved through arrayRule iteration: $. uses item, path: uses context', () => {
    const ctx = { allowed: 'launch' };
    const data = {
      orders: [
        { id: 'o1', campaign: 'launch', minTotal: 50, total: 100 },
        { id: 'o2', campaign: 'launch', minTotal: 200, total: 50 },
      ],
    };
    // For each order: campaign matches context.allowed AND total > $. minTotal
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.all,
      condition: {
        all: [
          { field: 'campaign', operator: Operator.equals, path: 'allowed' },
          { field: 'total', operator: Operator.greaterThan, path: '$.minTotal' },
        ],
      },
    };
    // o1: launch ✓, 100 > 50 ✓ → ok
    // o2: launch ✓, 50 > 200 ✗ → fails
    expect(typeof check(rule, data, { context: ctx })).toBe('string');
  });

  test('context preserved through deeply-nested all/any', () => {
    const ctx = { tier: 'enterprise' };
    const data = { plan: { tier: 'enterprise' } };
    const rule = {
      all: [
        {
          any: [
            { field: 'nope', operator: Operator.equals, value: 'x' },
            { field: 'plan.tier', operator: Operator.equals, path: 'tier' },
          ],
        },
      ],
    };
    expect(check(rule, data, { context: ctx })).toBe(true);
  });

  test('aggregate condition recursion preserves context', () => {
    const ctx = { minOrderStatus: 'completed' };
    const data = {
      orders: [
        { total: 100, status: 'completed' },
        { total: 50, status: 'pending' },
        { total: 200, status: 'completed' },
      ],
    };
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      condition: { field: 'status', operator: Operator.equals, path: 'minOrderStatus' },
      operator: Operator.equals,
      value: 300,
    };
    expect(check(rule, data, { context: ctx })).toBe(true);
  });

  test('explicit context distinct from data — context has bridge keys, path: ref walks them', () => {
    const data = { orders: [{ campaign: 'launch' }, { campaign: 'retention' }] };
    const context = {
      'salesforce:Contact': { preferredCampaign: 'launch' },
    };
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'campaign',
        operator: Operator.equals,
        path: 'salesforce:Contact.preferredCampaign',
      },
    };
    expect(check(rule, data, { context })).toBe(true);
  });

  test('context can be deeply structured like a source/map index', () => {
    // Context shaped like an index keyed by map:Model → id → row
    const data = { id: 'u1', crmId: 'c1', score: 50 };
    const context = {
      'salesforce:Contact': {
        c1: { id: 'c1', minScore: 30 },
        c2: { id: 'c2', minScore: 100 },
      },
    };
    // Rule traverses context.salesforce:Contact.c1.minScore via path:
    const rule = {
      field: 'score',
      operator: Operator.greaterThan,
      path: 'salesforce:Contact.c1.minScore',
    };
    expect(check(rule, data, { context })).toBe(true);
  });

  test('context distinct from data preserved through arrayRule iteration', () => {
    const data = { orders: [{ total: 200 }, { total: 30 }] };
    const ctx = { rules: { minOrder: 100 } };
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: {
        field: 'total',
        operator: Operator.greaterThan,
        path: 'rules.minOrder',
      },
    };
    // 200 > 100, 30 < 100 → any → true
    expect(check(rule, data, { context: ctx })).toBe(true);
  });

  test('context distinct from data preserved through aggregate', () => {
    const data = { orders: [{ total: 100 }, { total: 200 }] };
    const ctx = { caps: { total: 250 } };
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      operator: Operator.greaterThanEquals,
      path: 'caps.total',
    };
    // sum=300, caps.total=250 → 300 >= 250 → true
    expect(check(rule, data, { context: ctx })).toBe(true);
  });

  test('lens + sources are accepted but currently unused — no crash', () => {
    const data = { email: 'a@b.com' };
    const rule = { field: 'email', operator: Operator.equals, value: 'a@b.com' };
    expect(
      check(rule, data, {
        lens,
        sources: { 'prisma:User.list': [{ uuid: 'u1' }] },
      }),
    ).toBe(true);
  });
});
