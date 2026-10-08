import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { ArrayOperator, Operator } from '../src/operator';

// A bare value `path` reads the root row at any depth; a caller's values arrive only as binds.
// Both survive every recursion: all/any, array iteration, aggregate conditions.

describe('a bare path reads the root row through recursion', () => {
  test('through `all` into an array condition', () => {
    const data = { threshold: 50, orders: [{ total: 100 }, { total: 30 }] };
    const rule = {
      all: [
        {
          field: 'orders',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'total', operator: Operator.greaterThan, path: 'threshold' },
        },
      ],
    };
    expect(check(rule, data)).toBe(true);
    expect(typeof check(rule, { ...data, threshold: 500 })).toBe('string');
  });

  test('in array iteration: $. reads the item, a bare path the root row', () => {
    const data = {
      allowed: 'launch',
      orders: [
        { id: 'o1', campaign: 'launch', minTotal: 50, total: 100, allowed: 'other' },
        { id: 'o2', campaign: 'launch', minTotal: 200, total: 50, allowed: 'other' },
      ],
    };
    const rule = (operator: 'all' | 'any') => ({
      field: 'orders',
      arrayOperator: ArrayOperator[operator],
      condition: {
        all: [
          { field: 'campaign', operator: Operator.equals, path: 'allowed' },
          { field: 'total', operator: Operator.greaterThan, path: '$.minTotal' },
        ],
      },
    });
    // o1: launch = root 'launch' (not its own 'other') ✓, 100 > 50 ✓; o2: 50 > 200 ✗.
    expect(typeof check(rule('all'), data)).toBe('string');
    expect(check(rule('any'), data)).toBe(true);
  });

  test('through deeply-nested all/any', () => {
    const data = { tier: 'enterprise', plan: { tier: 'enterprise' } };
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
    expect(check(rule, data)).toBe(true);
  });

  test('in an aggregate condition and its comparison', () => {
    const data = {
      minOrderStatus: 'completed',
      caps: { total: 250 },
      orders: [
        { total: 100, status: 'completed' },
        { total: 50, status: 'pending' },
        { total: 200, status: 'completed' },
      ],
    };
    const filtered = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      condition: { field: 'status', operator: Operator.equals, path: 'minOrderStatus' },
      operator: Operator.equals,
      value: 300,
    };
    expect(check(filtered, data)).toBe(true);
    const capped = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      operator: Operator.greaterThanEquals,
      path: 'caps.total',
    };
    // sum=350 >= 250
    expect(check(capped, data)).toBe(true);
  });

  test('a bridge key on the root row is a plain property a bare path walks', () => {
    const data = {
      'salesforce:Contact': { preferredCampaign: 'launch' },
      orders: [{ campaign: 'launch' }, { campaign: 'retention' }],
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
    expect(check(rule, data)).toBe(true);
  });
});

describe("a caller's values are binds, through recursion", () => {
  test('in array iteration', () => {
    const data = { orders: [{ total: 200 }, { total: 30 }] };
    const rule = {
      field: 'orders',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'total', operator: Operator.greaterThan, bind: 'minOrder' },
    };
    // 200 > 100 → any → true; nothing over 500.
    expect(check(rule, data, { bindings: { minOrder: 100 } })).toBe(true);
    expect(typeof check(rule, data, { bindings: { minOrder: 500 } })).toBe('string');
  });

  test('in an aggregate comparison', () => {
    const data = { orders: [{ total: 100 }, { total: 200 }] };
    const rule = {
      field: 'orders',
      aggregate: { mode: 'sum' as const, field: 'total' },
      operator: Operator.greaterThanEquals,
      bind: 'cap',
    };
    // sum=300 >= 250
    expect(check(rule, data, { bindings: { cap: 250 } })).toBe(true);
  });

  test('a structured value from the caller: one bind per value', () => {
    // An index keyed by map:Model → id → row lives with the caller; the rule names the value.
    const index = { 'salesforce:Contact': { c1: { minScore: 30 }, c2: { minScore: 100 } } };
    const data = { id: 'u1', crmId: 'c1', score: 50 };
    const rule = { field: 'score', operator: Operator.greaterThan, bind: 'minScore' };
    const bindings = { minScore: index['salesforce:Contact'].c1.minScore };
    expect(check(rule, data, { bindings })).toBe(true);
  });
});
