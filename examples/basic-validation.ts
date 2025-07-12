import { check, Operator } from '../index';

// Example 1: Simple field validation
const ageRule = {
  field: 'age',
  operator: Operator.greaterThanEqual,
  value: 18,
  error: 'You must be 18 or older to register'
};

console.log(check(ageRule, { age: 21 })); // true
console.log(check(ageRule, { age: 16 })); // "You must be 18 or older to register"

// Example 2: Email validation with regex
const emailRule = {
  field: 'email',
  operator: Operator.match,
  value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  error: 'Please enter a valid email address'
};

console.log(check(emailRule, { email: 'user@example.com' })); // true
console.log(check(emailRule, { email: 'invalid-email' })); // "Please enter a valid email address"

// Example 3: Range validation
const scoreRule = {
  field: 'score',
  operator: Operator.between,
  value: [0, 100],
  error: 'Score must be between 0 and 100'
};

console.log(check(scoreRule, { score: 85 })); // true
console.log(check(scoreRule, { score: 150 })); // "Score must be between 0 and 100"

// Example 4: Membership check
const roleRule = {
  field: 'role',
  operator: Operator.in,
  value: ['admin', 'editor', 'viewer'],
  error: 'Invalid role selected'
};

console.log(check(roleRule, { role: 'admin' })); // true
console.log(check(roleRule, { role: 'guest' })); // "Invalid role selected"

// Example 5: String operations
const urlRule = {
  field: 'website',
  operator: Operator.startsWith,
  value: 'https://',
  error: 'Website must use HTTPS'
};

console.log(check(urlRule, { website: 'https://example.com' })); // true
console.log(check(urlRule, { website: 'http://example.com' })); // "Website must use HTTPS"

// Example 6: Existence checks
const phoneRule = {
  field: 'phone',
  operator: Operator.notEmpty,
  error: 'Phone number is required'
};

console.log(check(phoneRule, { phone: '+1-555-0123' })); // true
console.log(check(phoneRule, { phone: '' })); // "Phone number is required"
console.log(check(phoneRule, { phone: null })); // "Phone number is required"