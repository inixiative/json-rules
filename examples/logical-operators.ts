import { check, Operator } from '../index';

// Example 1: AND logic - All conditions must pass
const userEligibilityRule = {
  all: [
    { field: 'age', operator: Operator.greaterThanEqual, value: 18 },
    { field: 'hasLicense', operator: Operator.equal, value: true },
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

console.log(check(userEligibilityRule, eligibleUser)); // true
console.log(check(userEligibilityRule, ineligibleUser)); // "age must be greater than or equal to 18"

// Example 2: OR logic - At least one condition must pass
const accessRule = {
  any: [
    { field: 'role', operator: Operator.equal, value: 'admin' },
    { field: 'isOwner', operator: Operator.equal, value: true },
    { field: 'permissions', operator: Operator.contains, value: 'write' }
  ],
  error: 'Access denied'
};

const adminUser = { role: 'admin', isOwner: false, permissions: [] };
const ownerUser = { role: 'user', isOwner: true, permissions: [] };
const regularUser = { role: 'user', isOwner: false, permissions: ['read'] };

console.log(check(accessRule, adminUser)); // true
console.log(check(accessRule, ownerUser)); // true
console.log(check(accessRule, regularUser)); // "Access denied"

// Example 3: Nested logic
const complexRule = {
  all: [
    { field: 'type', operator: Operator.equal, value: 'premium' },
    {
      any: [
        { field: 'paymentMethod', operator: Operator.equal, value: 'credit' },
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

console.log(check(complexRule, validPremium)); // true
console.log(check(complexRule, invalidPremium)); // "At least one condition must pass: paymentMethod must equal \"credit\" OR balance must be greater than 100"

// Example 4: Combining with boolean conditions
const conditionalRule = {
  all: [
    true, // Always passes
    { field: 'active', operator: Operator.equal, value: true },
    false // Always fails - useful for temporarily disabling rules
  ]
};

console.log(check(conditionalRule, { active: true })); // "false"