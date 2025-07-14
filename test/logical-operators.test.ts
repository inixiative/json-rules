import { describe, expect, test } from 'bun:test';
import { check, Operator } from '../index';

describe('Logical Operators Examples', () => {
  test('AND logic - user eligibility', () => {
    const userEligibilityRule = {
      all: [
        { field: 'age', operator: Operator.greaterThanEquals, value: 18 },
        { field: 'hasLicense', operator: Operator.equals, value: true },
        { field: 'violations', operator: Operator.lessThan, value: 3 }
      ],
      error: 'User is not eligible for driving privileges'
    };

    const eligibleUser = {
      age: 25,
      hasLicense: true,
      violations: 1
    };

    const ineligibleUser = {
      age: 17,
      hasLicense: true,
      violations: 0
    };

    expect(check(userEligibilityRule, eligibleUser)).toBe(true);
    expect(check(userEligibilityRule, ineligibleUser)).toBe('User is not eligible for driving privileges');
  });

  test('OR logic - access control', () => {
    const accessRule = {
      any: [
        { field: 'role', operator: Operator.equals, value: 'admin' },
        { field: 'isOwner', operator: Operator.equals, value: true },
        { field: 'permissions', operator: Operator.contains, value: 'write' }
      ],
      error: 'Access denied'
    };

    const adminUser = { role: 'admin', isOwner: false, permissions: [] };
    const ownerUser = { role: 'user', isOwner: true, permissions: [] };
    const regularUser = { role: 'user', isOwner: false, permissions: ['read'] };

    expect(check(accessRule, adminUser)).toBe(true);
    expect(check(accessRule, ownerUser)).toBe(true);
    expect(check(accessRule, regularUser)).toBe('Access denied');
  });

  test('nested logic', () => {
    const complexRule = {
      all: [
        { field: 'type', operator: Operator.equals, value: 'premium' },
        {
          any: [
            { field: 'paymentMethod', operator: Operator.equals, value: 'credit' },
            { field: 'balance', operator: Operator.greaterThan, value: 100 }
          ]
        }
      ]
    };

    const validPremium = {
      type: 'premium',
      paymentMethod: 'credit',
      balance: 50
    };

    const invalidPremium = {
      type: 'premium',
      paymentMethod: 'cash',
      balance: 50
    };

    expect(check(complexRule, validPremium)).toBe(true);
    expect(check(complexRule, invalidPremium)).toContain('At least one condition must pass');
  });

  test('combining with boolean conditions', () => {
    const conditionalRule = {
      all: [
        true, // Always passes
        { field: 'active', operator: Operator.equals, value: true },
        false // Always fails - useful for temporarily disabling rules
      ]
    };

    expect(check(conditionalRule, { active: true })).toBe('false');
  });
});