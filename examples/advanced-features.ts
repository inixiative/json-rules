import { check, Operator, ArrayOperator } from '../index';

// Example 1: Path-based field comparison
const passwordMatchRule = {
  field: 'confirmPassword',
  operator: Operator.equal,
  path: 'password',
  error: 'Passwords do not match'
};

const validPasswords = {
  password: 'SecurePass123!',
  confirmPassword: 'SecurePass123!'
};

const invalidPasswords = {
  password: 'SecurePass123!',
  confirmPassword: 'SecurePass456!'
};

console.log(check(passwordMatchRule, validPasswords)); // true
console.log(check(passwordMatchRule, invalidPasswords)); // "Passwords do not match"

// Example 2: If-Then-Else conditional logic
const discountRule = {
  if: { field: 'membershipLevel', operator: Operator.equal, value: 'premium' },
  then: { field: 'discount', operator: Operator.greaterThanEqual, value: 0.2 },
  else: { field: 'discount', operator: Operator.equal, value: 0 }
};

const premiumMember = { membershipLevel: 'premium', discount: 0.25 };
const regularMember = { membershipLevel: 'regular', discount: 0 };
const invalidPremium = { membershipLevel: 'premium', discount: 0.1 };

console.log(check(discountRule, premiumMember)); // true
console.log(check(discountRule, regularMember)); // true
console.log(check(discountRule, invalidPremium)); // "discount must be greater than or equal to 0.2"

// Example 3: Array element context with $.path
const budgetComplianceRule = {
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'total',
    operator: Operator.lessThanEqual,
    path: '$.maxBudget' // Reference field on the current array element
  }
};

const ordersWithBudget = {
  orders: [
    { id: 1, total: 100, maxBudget: 150 },
    { id: 2, total: 200, maxBudget: 250 },
    { id: 3, total: 50, maxBudget: 100 }
  ]
};

console.log(check(budgetComplianceRule, ordersWithBudget)); // true

// Example 4: Complex nested validation
const userValidationRule = {
  all: [
    // Basic field validation
    { field: 'username', operator: Operator.match, value: /^[a-zA-Z0-9_]{3,20}$/ },
    { field: 'email', operator: Operator.match, value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
    
    // Conditional age verification
    {
      if: { field: 'country', operator: Operator.equal, value: 'US' },
      then: { field: 'age', operator: Operator.greaterThanEqual, value: 21 },
      else: { field: 'age', operator: Operator.greaterThanEqual, value: 18 }
    },
    
    // At least one verified contact method
    {
      any: [
        { field: 'emailVerified', operator: Operator.equal, value: true },
        { field: 'phoneVerified', operator: Operator.equal, value: true }
      ]
    }
  ]
};

// Example 5: Dynamic threshold validation
const inventoryRule = {
  field: 'products',
  arrayOperator: ArrayOperator.all,
  condition: {
    if: { field: 'category', operator: Operator.equal, value: 'perishable' },
    then: { field: 'stock', operator: Operator.lessThan, path: '$.maxStock' },
    else: { field: 'stock', operator: Operator.lessThanEqual, path: '$.maxStock' }
  }
};

const inventory = {
  products: [
    { name: 'Milk', category: 'perishable', stock: 50, maxStock: 100 },
    { name: 'Cereal', category: 'non-perishable', stock: 200, maxStock: 200 }
  ]
};

console.log(check(inventoryRule, inventory)); // true

// Example 6: Cross-referencing with root context
const orderLimitRule = {
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'amount',
    operator: Operator.lessThanEqual,
    path: 'user.creditLimit' // Reference root context, not array element
  }
};

const userWithOrders = {
  user: { name: 'John', creditLimit: 1000 },
  orders: [
    { id: 1, amount: 300 },
    { id: 2, amount: 500 },
    { id: 3, amount: 200 }
  ]
};

console.log(check(orderLimitRule, userWithOrders)); // true

// Example 7: Combining all features
const complexBusinessRule = {
  all: [
    // User must be active
    { field: 'status', operator: Operator.equal, value: 'active' },
    
    // Subscription validation
    {
      if: { field: 'subscription.type', operator: Operator.equal, value: 'enterprise' },
      then: {
        all: [
          { field: 'subscription.seats', operator: Operator.greaterThanEqual, value: 10 },
          { field: 'subscription.budget', operator: Operator.greaterThan, value: 10000 }
        ]
      }
    },
    
    // All projects must be within limits
    {
      field: 'projects',
      arrayOperator: ArrayOperator.all,
      condition: {
        all: [
          { field: 'budget', operator: Operator.lessThanEqual, path: 'company.maxProjectBudget' },
          { field: 'teamSize', operator: Operator.lessThanEqual, value: 50 },
          {
            field: 'technologies',
            arrayOperator: ArrayOperator.any,
            condition: { field: 'approved', operator: Operator.equal, value: true }
          }
        ]
      }
    }
  ]
};