import { describe, expect, test } from 'bun:test';
import { check, Operator, ArrayOperator } from '../index';

describe('Array Operations Examples', () => {
  test('all array elements must match', () => {
    const allItemsActiveRule = {
      field: 'items',
      arrayOperator: ArrayOperator.all,
      condition: { field: 'active', operator: Operator.equals, value: true }
    };

    const allActive = {
      items: [
        { id: 1, active: true },
        { id: 2, active: true },
        { id: 3, active: true }
      ]
    };

    const someInactive = {
      items: [
        { id: 1, active: true },
        { id: 2, active: false },
        { id: 3, active: true }
      ]
    };

    expect(check(allItemsActiveRule, allActive)).toBe(true);
    expect(check(allItemsActiveRule, someInactive)).toBe('items all elements must match (1 failed)');
  });

  test('at least one element must match', () => {
    const hasAdminRule = {
      field: 'users',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'role', operator: Operator.equals, value: 'admin' }
    };

    const teamWithAdmin = {
      users: [
        { name: 'Alice', role: 'user' },
        { name: 'Bob', role: 'admin' },
        { name: 'Charlie', role: 'user' }
      ]
    };

    const teamWithoutAdmin = {
      users: [
        { name: 'Alice', role: 'user' },
        { name: 'Bob', role: 'user' }
      ]
    };

    expect(check(hasAdminRule, teamWithAdmin)).toBe(true);
    expect(check(hasAdminRule, teamWithoutAdmin)).toBe('users at least one element must match');
  });

  test('count-based validation', () => {
    const minimumOrdersRule = {
      field: 'orders',
      arrayOperator: ArrayOperator.atLeast,
      count: 2,
      condition: { field: 'status', operator: Operator.equals, value: 'completed' }
    };

    const customerOrders = {
      orders: [
        { id: 1, status: 'completed' },
        { id: 2, status: 'pending' },
        { id: 3, status: 'completed' },
        { id: 4, status: 'completed' }
      ]
    };

    expect(check(minimumOrdersRule, customerOrders)).toBe(true);
  });

  test('exactly X elements', () => {
    const singleLeaderRule = {
      field: 'team',
      arrayOperator: ArrayOperator.exactly,
      count: 1,
      condition: { field: 'role', operator: Operator.equals, value: 'leader' },
      error: 'Team must have exactly one leader'
    };

    const validTeam = {
      team: [
        { name: 'Alice', role: 'leader' },
        { name: 'Bob', role: 'member' },
        { name: 'Charlie', role: 'member' }
      ]
    };

    const invalidTeam = {
      team: [
        { name: 'Alice', role: 'leader' },
        { name: 'Bob', role: 'leader' },
        { name: 'Charlie', role: 'member' }
      ]
    };

    expect(check(singleLeaderRule, validTeam)).toBe(true);
    expect(check(singleLeaderRule, invalidTeam)).toBe('Team must have exactly one leader');
  });

  test('empty/notEmpty array checks', () => {
    const hasItemsRule = {
      field: 'cart',
      arrayOperator: ArrayOperator.notEmpty,
      error: 'Shopping cart cannot be empty'
    };

    expect(check(hasItemsRule, { cart: [{ item: 'apple' }] })).toBe(true);
    expect(check(hasItemsRule, { cart: [] })).toBe('Shopping cart cannot be empty');
  });

  test('complex array conditions', () => {
    const qualityCheckRule = {
      field: 'products',
      arrayOperator: ArrayOperator.all,
      condition: {
        all: [
          { field: 'price', operator: Operator.greaterThan, value: 0 },
          { field: 'stock', operator: Operator.greaterThanEquals, value: 0 },
          { field: 'name', operator: Operator.notEmpty }
        ]
      }
    };

    const validProducts = {
      products: [
        { name: 'Widget', price: 10, stock: 5 },
        { name: 'Gadget', price: 20, stock: 0 }
      ]
    };

    expect(check(qualityCheckRule, validProducts)).toBe(true);
  });

  test('using contains for primitive arrays', () => {
    const tagsRule = {
      field: 'tags',
      operator: Operator.contains,
      value: 'featured'
    };

    expect(check(tagsRule, { tags: ['new', 'featured', 'sale'] })).toBe(true);
    expect(check(tagsRule, { tags: ['new', 'sale'] })).toBe('tags must contain "featured"');
  });
});