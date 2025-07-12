import { check, Operator, ArrayOperator, DateOperator } from '../index';

// Example 1: E-commerce Order Validation
const orderValidationRule = {
  all: [
    // Order must have items
    { field: 'items', arrayOperator: ArrayOperator.notEmpty, error: 'Order must contain at least one item' },
    
    // All items must be valid
    {
      field: 'items',
      arrayOperator: ArrayOperator.all,
      condition: {
        all: [
          { field: 'quantity', operator: Operator.greaterThan, value: 0 },
          { field: 'price', operator: Operator.greaterThan, value: 0 },
          { field: 'inStock', operator: Operator.equal, value: true }
        ]
      }
    },
    
    // Shipping address validation
    {
      all: [
        { field: 'shipping.street', operator: Operator.notEmpty },
        { field: 'shipping.city', operator: Operator.notEmpty },
        { field: 'shipping.zipCode', operator: Operator.match, value: /^\d{5}(-\d{4})?$/ },
        { field: 'shipping.country', operator: Operator.in, value: ['US', 'CA', 'MX'] }
      ]
    },
    
    // Payment validation
    {
      if: { field: 'paymentMethod', operator: Operator.equal, value: 'credit_card' },
      then: {
        all: [
          { field: 'cardNumber', operator: Operator.match, value: /^\d{16}$/ },
          { field: 'cvv', operator: Operator.match, value: /^\d{3,4}$/ },
          { field: 'expiryDate', dateOperator: DateOperator.after, value: new Date().toISOString() }
        ]
      }
    }
  ]
};

// Example 2: User Registration Form
const registrationRule = {
  all: [
    // Username validation
    {
      field: 'username',
      operator: Operator.match,
      value: /^[a-zA-Z0-9_]{3,20}$/,
      error: 'Username must be 3-20 characters and contain only letters, numbers, and underscores'
    },
    
    // Email validation
    {
      field: 'email',
      operator: Operator.match,
      value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      error: 'Please provide a valid email address'
    },
    
    // Password strength
    {
      all: [
        { field: 'password', operator: Operator.match, value: /.{8,}/, error: 'Password must be at least 8 characters' },
        { field: 'password', operator: Operator.match, value: /[A-Z]/, error: 'Password must contain an uppercase letter' },
        { field: 'password', operator: Operator.match, value: /[a-z]/, error: 'Password must contain a lowercase letter' },
        { field: 'password', operator: Operator.match, value: /[0-9]/, error: 'Password must contain a number' },
        { field: 'password', operator: Operator.match, value: /[^A-Za-z0-9]/, error: 'Password must contain a special character' }
      ]
    },
    
    // Password confirmation
    { field: 'confirmPassword', operator: Operator.equal, path: 'password', error: 'Passwords must match' },
    
    // Terms acceptance
    { field: 'acceptTerms', operator: Operator.equal, value: true, error: 'You must accept the terms and conditions' }
  ]
};

// Example 3: Loan Application
const loanApplicationRule = {
  all: [
    // Basic eligibility
    { field: 'age', operator: Operator.between, value: [18, 65], error: 'Applicant must be between 18 and 65 years old' },
    { field: 'citizenship', operator: Operator.equal, value: true, error: 'Must be a citizen to apply' },
    
    // Income requirements
    {
      if: { field: 'loanAmount', operator: Operator.greaterThan, value: 50000 },
      then: { field: 'annualIncome', operator: Operator.greaterThanEqual, value: 100000 },
      else: { field: 'annualIncome', operator: Operator.greaterThanEqual, value: 40000 }
    },
    
    // Employment history
    {
      field: 'employmentHistory',
      arrayOperator: ArrayOperator.atLeast,
      count: 1,
      condition: {
        all: [
          { field: 'duration', operator: Operator.greaterThanEqual, value: 24 }, // 24 months
          { field: 'currentJob', operator: Operator.equal, value: true }
        ]
      },
      error: 'Must have at least 2 years of continuous employment'
    },
    
    // Credit score requirement
    { field: 'creditScore', operator: Operator.greaterThanEqual, value: 650, error: 'Credit score must be at least 650' }
  ]
};

// Example 4: Event Scheduling System
const eventSchedulingRule = {
  all: [
    // Event must be in the future
    { field: 'startDate', dateOperator: DateOperator.after, value: new Date().toISOString() },
    
    // End date must be after start date
    { field: 'endDate', dateOperator: DateOperator.after, path: 'startDate' },
    
    // Venue availability (no conflicts)
    {
      field: 'conflicts',
      arrayOperator: ArrayOperator.none,
      condition: {
        all: [
          { field: 'venueId', operator: Operator.equal, path: 'venue.id' },
          {
            any: [
              // Our event starts during another event
              {
                all: [
                  { field: 'startDate', dateOperator: DateOperator.onOrBefore, path: '$.startDate' },
                  { field: 'endDate', dateOperator: DateOperator.after, path: '$.startDate' }
                ]
              },
              // Our event ends during another event
              {
                all: [
                  { field: 'startDate', dateOperator: DateOperator.before, path: '$.endDate' },
                  { field: 'endDate', dateOperator: DateOperator.onOrAfter, path: '$.endDate' }
                ]
              }
            ]
          }
        ]
      },
      error: 'Venue is not available for the selected dates'
    },
    
    // Capacity check
    { field: 'attendees', operator: Operator.lessThanEqual, path: 'venue.capacity' }
  ]
};

// Example 5: API Rate Limiting
const rateLimitRule = {
  any: [
    // Premium users have higher limits
    {
      all: [
        { field: 'user.plan', operator: Operator.equal, value: 'premium' },
        { field: 'requests.count', operator: Operator.lessThanEqual, value: 10000 }
      ]
    },
    // Regular users have standard limits
    {
      all: [
        { field: 'user.plan', operator: Operator.notEqual, value: 'premium' },
        { field: 'requests.count', operator: Operator.lessThanEqual, value: 1000 }
      ]
    }
  ],
  error: 'Rate limit exceeded'
};

// Example usage with error handling
function validateOrder(orderData: any) {
  const result = check(orderValidationRule, orderData);
  
  if (result === true) {
    console.log('Order is valid');
    return { success: true };
  } else {
    console.error('Order validation failed:', result);
    return { success: false, error: result };
  }
}

// Test data
const validOrder = {
  items: [
    { id: 1, quantity: 2, price: 29.99, inStock: true },
    { id: 2, quantity: 1, price: 49.99, inStock: true }
  ],
  shipping: {
    street: '123 Main St',
    city: 'New York',
    zipCode: '10001',
    country: 'US'
  },
  paymentMethod: 'credit_card',
  cardNumber: '1234567812345678',
  cvv: '123',
  expiryDate: '2025-12-31'
};

console.log(validateOrder(validOrder)); // { success: true }