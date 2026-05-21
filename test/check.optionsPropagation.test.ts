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
