# json-rules

A powerful, type-safe JSON-based rules engine for TypeScript/JavaScript applications. Define complex validation and business logic rules using simple JSON structures.

## Features

- 🎯 **Type-safe**: Full TypeScript support with strict type checking
- 🔧 **Flexible**: 22 standard operators, 8 array operators, and 8 date operators
- 🌳 **Composable**: Nest rules with logical operators (all/any) and conditional logic (if-then-else)
- 📊 **Array validation**: Rich array validation with element-wise conditions
- 📅 **Date handling**: Comprehensive date comparison with timezone support
- 🔍 **Path-based access**: Reference values from anywhere in your data structure
- 💬 **Custom errors**: Every rule supports custom error messages

## Installation

```bash
npm install json-rules
# or
yarn add json-rules
# or
bun add json-rules
```

## Quick Start

```typescript
import { check, Operator } from 'json-rules';

// Simple rule
const rule = {
  field: 'age',
  operator: Operator.greaterThanEqual,
  value: 18,
  error: 'Must be 18 or older'
};

const result = check(rule, { age: 21 });  // returns true
const result2 = check(rule, { age: 16 }); // returns "Must be 18 or older"
```

## Operators

### Standard Operators (22)

#### Comparison
- `equal` - Exact equality check
- `notEqual` - Not equal check
- `lessThan` - Less than comparison
- `lessThanEqual` - Less than or equal
- `greaterThan` - Greater than comparison
- `greaterThanEqual` - Greater than or equal

#### Range
- `between` - Value within range (inclusive)
- `notBetween` - Value outside range

#### Membership
- `in` - Value in array
- `notIn` - Value not in array
- `contains` - Array/string contains value
- `notContains` - Array/string doesn't contain value

#### String
- `startsWith` - String starts with value
- `endsWith` - String ends with value

#### Pattern
- `match` - Regex pattern match
- `notMatch` - Regex pattern doesn't match

#### Existence
- `isEmpty` - Check if value is empty (null, undefined, "", [], {})
- `notEmpty` - Check if value is not empty
- `exists` - Field exists (not undefined)
- `notExists` - Field doesn't exist (undefined)

### Array Operators (8)

- `all` - All elements match condition
- `any` - At least one element matches
- `none` - No elements match
- `atLeast` - At least X elements match
- `atMost` - At most X elements match
- `exactly` - Exactly X elements match
- `empty` - Array is empty
- `notEmpty` - Array has elements

### Date Operators (8)

- `before` - Date is before comparison date
- `after` - Date is after comparison date
- `onOrBefore` - Date is on or before
- `onOrAfter` - Date is on or after
- `between` - Date is between two dates
- `notBetween` - Date is outside range
- `dayIn` - Day of week is in list
- `dayNotIn` - Day of week is not in list

## Rule Types

### Basic Rule

```typescript
{
  field: 'status',
  operator: Operator.equal,
  value: 'active'
}
```

### Logical Operators

```typescript
// All conditions must pass (AND)
{
  all: [
    { field: 'age', operator: Operator.greaterThanEqual, value: 18 },
    { field: 'hasLicense', operator: Operator.equal, value: true }
  ]
}

// At least one must pass (OR)
{
  any: [
    { field: 'role', operator: Operator.equal, value: 'admin' },
    { field: 'isOwner', operator: Operator.equal, value: true }
  ]
}
```

### Conditional Logic (If-Then-Else)

```typescript
{
  if: { field: 'type', operator: Operator.equal, value: 'premium' },
  then: { field: 'discount', operator: Operator.greaterThan, value: 0 },
  else: { field: 'discount', operator: Operator.equal, value: 0 }
}
```

### Array Validation

```typescript
{
  field: 'orders',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'total',
    operator: Operator.lessThan,
    value: 1000
  }
}
```

### Date Validation

```typescript
{
  field: 'expiryDate',
  dateOperator: DateOperator.after,
  value: '2024-12-31'
}
```

## Advanced Features

### Path-Based Value Resolution

Compare fields against each other using paths:

```typescript
{
  field: 'confirmPassword',
  operator: Operator.equal,
  path: 'password'  // Compare against another field
}
```

### Array Element Context

Use `$.` prefix to reference the current array element:

```typescript
{
  field: 'items',
  arrayOperator: ArrayOperator.all,
  condition: {
    field: 'price',
    operator: Operator.lessThan,
    path: '$.maxPrice'  // Reference field on current array element
  }
}
```

### Custom Error Messages

Every rule supports custom error messages:

```typescript
{
  field: 'email',
  operator: Operator.match,
  value: /^[^@]+@[^@]+\.[^@]+$/,
  error: 'Please enter a valid email address'
}
```

## Complex Example

```typescript
const rule = {
  all: [
    // User must be active
    { field: 'status', operator: Operator.equal, value: 'active' },
    
    // Age requirement
    { field: 'age', operator: Operator.between, value: [18, 65] },
    
    // Must have at least one verified email
    {
      field: 'emails',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'verified', operator: Operator.equal, value: true }
    },
    
    // Conditional premium features
    {
      if: { field: 'subscription', operator: Operator.equal, value: 'premium' },
      then: {
        field: 'features',
        arrayOperator: ArrayOperator.all,
        condition: { field: 'enabled', operator: Operator.equal, value: true }
      }
    }
  ]
};

const userData = {
  status: 'active',
  age: 25,
  emails: [
    { address: 'user@example.com', verified: true },
    { address: 'alt@example.com', verified: false }
  ],
  subscription: 'premium',
  features: [
    { name: 'advanced', enabled: true },
    { name: 'analytics', enabled: true }
  ]
};

const result = check(rule, userData); // returns true
```

## API Reference

### `check(condition: Condition, data: any, context?: any): boolean | string`

The main validation function.

- **condition**: The rule to evaluate
- **data**: The data to validate against
- **context**: Optional context (defaults to data)
- **Returns**: `true` if validation passes, error string if it fails

### Types

```typescript
type Condition = Rule | ArrayRule | DateRule | All | Any | IfThenElse | boolean;

type Rule = {
  field: string;
  operator: Operator;
  value?: any;
  path?: string;
  error?: string;
};

type ArrayRule = {
  field: string;
  arrayOperator: ArrayOperator;
  condition?: Condition;
  count?: number;
  error?: string;
};

type DateRule = {
  field: string;
  dateOperator: DateOperator;
  value?: any;
  path?: string;
  error?: string;
};
```

## Error Handling

The engine throws errors for:
- Invalid array fields when using array operators
- Missing required parameters (e.g., count for atLeast)
- Invalid dates in date comparisons
- Primitive arrays with array operators (use `contains` or `in` instead)

## License

MIT