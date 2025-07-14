import { check, Operator, ArrayOperator } from '../index';

// Example 1: All array elements must match
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

console.log(check(allItemsActiveRule, allActive)); // true
console.log(check(allItemsActiveRule, someInactive)); // "items all elements must match (1 failed)"

// Example 2: At least one element must match
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

console.log(check(hasAdminRule, teamWithAdmin)); // true
console.log(check(hasAdminRule, teamWithoutAdmin)); // "users at least one element must match"

// Example 3: Count-based validation
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

console.log(check(minimumOrdersRule, customerOrders)); // true (3 completed orders)

// Example 4: Exactly X elements
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

console.log(check(singleLeaderRule, validTeam)); // true
console.log(check(singleLeaderRule, invalidTeam)); // "Team must have exactly one leader"

// Example 5: Empty/NotEmpty array checks
const hasItemsRule = {
  field: 'cart',
  arrayOperator: ArrayOperator.notEmpty,
  error: 'Shopping cart cannot be empty'
};

console.log(check(hasItemsRule, { cart: [{ item: 'apple' }] })); // true
console.log(check(hasItemsRule, { cart: [] })); // "Shopping cart cannot be empty"

// Example 6: Complex array conditions
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

console.log(check(qualityCheckRule, validProducts)); // true

// Example 7: Using contains for primitive arrays
const tagsRule = {
  field: 'tags',
  operator: Operator.contains,
  value: 'featured'
};

console.log(check(tagsRule, { tags: ['new', 'featured', 'sale'] })); // true
console.log(check(tagsRule, { tags: ['new', 'sale'] })); // "tags must contain \"featured\""