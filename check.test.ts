import { describe, expect, test } from 'bun:test';
import { check, Operator, ArrayOperator, DateOperator } from './index';

describe('Basic Rule Tests', () => {
  test('equal operator', () => {
    const rule = { field: 'name', operator: Operator.equal, value: 'John' };
    expect(check(rule, { name: 'John' })).toBe(true);
    expect(check(rule, { name: 'Jane' })).toBe('name must equal "John"');
  });

  test('notEqual operator', () => {
    const rule = { field: 'status', operator: Operator.notEqual, value: 'inactive' };
    expect(check(rule, { status: 'active' })).toBe(true);
    expect(check(rule, { status: 'inactive' })).toBe('status must not equal "inactive"');
  });

  test('numeric comparisons', () => {
    const data = { age: 25 };
    
    expect(check({ field: 'age', operator: Operator.greaterThan, value: 20 }, data)).toBe(true);
    expect(check({ field: 'age', operator: Operator.greaterThan, value: 30 }, data)).toBe('age must be greater than 30');
    
    expect(check({ field: 'age', operator: Operator.lessThan, value: 30 }, data)).toBe(true);
    expect(check({ field: 'age', operator: Operator.lessThanEqual, value: 25 }, data)).toBe(true);
    expect(check({ field: 'age', operator: Operator.greaterThanEqual, value: 25 }, data)).toBe(true);
  });

  test('custom error messages', () => {
    const rule = { 
      field: 'age', 
      operator: Operator.greaterThanEqual, 
      value: 18,
      error: 'You must be 18 or older' 
    };
    expect(check(rule, { age: 16 })).toBe('You must be 18 or older');
  });
});

describe('String Operators', () => {
  test('contains operator', () => {
    const rule = { field: 'email', operator: Operator.contains, value: '@gmail' };
    expect(check(rule, { email: 'user@gmail.com' })).toBe(true);
    expect(check(rule, { email: 'user@yahoo.com' })).toBe('email must contain "@gmail"');
  });

  test('startsWith and endsWith', () => {
    const data = { url: 'https://example.com' };
    
    expect(check({ field: 'url', operator: Operator.startsWith, value: 'https://' }, data)).toBe(true);
    expect(check({ field: 'url', operator: Operator.startsWith, value: 'http://' }, data)).toBe('url must start with "http://"');
    
    expect(check({ field: 'url', operator: Operator.endsWith, value: '.com' }, data)).toBe(true);
    expect(check({ field: 'url', operator: Operator.endsWith, value: '.org' }, data)).toBe('url must end with ".org"');
  });

  test('match operator with regex', () => {
    const rule = { field: 'email', operator: Operator.match, value: /^[^@]+@[^@]+\.[^@]+$/ };
    expect(check(rule, { email: 'valid@email.com' })).toBe(true);
    expect(check(rule, { email: 'invalid-email' })).toContain('must match pattern');
  });
});

describe('Range and Membership Operators', () => {
  test('between operator', () => {
    const rule = { field: 'score', operator: Operator.between, value: [0, 100] };
    expect(check(rule, { score: 50 })).toBe(true);
    expect(check(rule, { score: 0 })).toBe(true);
    expect(check(rule, { score: 100 })).toBe(true);
    expect(check(rule, { score: 101 })).toBe('score must be between [0,100]');
  });

  test('in operator', () => {
    const rule = { field: 'role', operator: Operator.in, value: ['admin', 'moderator', 'user'] };
    expect(check(rule, { role: 'admin' })).toBe(true);
    expect(check(rule, { role: 'guest' })).toBe('role must be one of ["admin","moderator","user"]');
  });

  test('notIn operator', () => {
    const rule = { field: 'status', operator: Operator.notIn, value: ['banned', 'suspended'] };
    expect(check(rule, { status: 'active' })).toBe(true);
    expect(check(rule, { status: 'banned' })).toBe('status must not be one of ["banned","suspended"]');
  });
});

describe('Existence Operators', () => {
  test('exists and notExists', () => {
    const data = { name: 'John', age: undefined };
    
    expect(check({ field: 'name', operator: Operator.exists }, data)).toBe(true);
    expect(check({ field: 'age', operator: Operator.exists }, data)).toBe('age must exist');
    expect(check({ field: 'missing', operator: Operator.notExists }, data)).toBe(true);
  });

  test('isEmpty and notEmpty', () => {
    expect(check({ field: 'val', operator: Operator.isEmpty }, { val: '' })).toBe(true);
    expect(check({ field: 'val', operator: Operator.isEmpty }, { val: [] })).toBe(true);
    expect(check({ field: 'val', operator: Operator.isEmpty }, { val: {} })).toBe(true);
    expect(check({ field: 'val', operator: Operator.isEmpty }, { val: null })).toBe(true);
    expect(check({ field: 'val', operator: Operator.isEmpty }, { val: 'text' })).toBe('val must be empty');
    
    expect(check({ field: 'val', operator: Operator.notEmpty }, { val: 'text' })).toBe(true);
    expect(check({ field: 'val', operator: Operator.notEmpty }, { val: [1] })).toBe(true);
    expect(check({ field: 'val', operator: Operator.notEmpty }, { val: '' })).toBe('val must not be empty');
  });
});

describe('Logical Operators', () => {
  test('all operator (AND)', () => {
    const rule = {
      all: [
        { field: 'age', operator: Operator.greaterThanEqual, value: 18 },
        { field: 'status', operator: Operator.equal, value: 'active' }
      ]
    };
    
    expect(check(rule, { age: 20, status: 'active' })).toBe(true);
    expect(check(rule, { age: 16, status: 'active' })).toBe('age must be greater than or equal to 18');
    expect(check(rule, { age: 16, status: 'inactive' })).toContain('All conditions must pass');
  });

  test('any operator (OR)', () => {
    const rule = {
      any: [
        { field: 'role', operator: Operator.equal, value: 'admin' },
        { field: 'isOwner', operator: Operator.equal, value: true }
      ]
    };
    
    expect(check(rule, { role: 'admin', isOwner: false })).toBe(true);
    expect(check(rule, { role: 'user', isOwner: true })).toBe(true);
    expect(check(rule, { role: 'user', isOwner: false })).toContain('At least one condition must pass');
  });

  test('nested logical operators', () => {
    const rule = {
      all: [
        { field: 'type', operator: Operator.equal, value: 'user' },
        {
          any: [
            { field: 'verified', operator: Operator.equal, value: true },
            { field: 'trusted', operator: Operator.equal, value: true }
          ]
        }
      ]
    };
    
    expect(check(rule, { type: 'user', verified: true, trusted: false })).toBe(true);
    expect(check(rule, { type: 'user', verified: false, trusted: false })).toContain('At least one condition must pass');
  });
});

describe('If-Then-Else Logic', () => {
  test('if-then logic', () => {
    const rule = {
      if: { field: 'type', operator: Operator.equal, value: 'premium' },
      then: { field: 'discount', operator: Operator.greaterThan, value: 0 }
    };
    
    expect(check(rule, { type: 'premium', discount: 10 })).toBe(true);
    expect(check(rule, { type: 'premium', discount: 0 })).toBe('discount must be greater than 0');
    expect(check(rule, { type: 'basic', discount: 0 })).toBe(true); // if fails, no else, returns true
  });

  test('if-then-else logic', () => {
    const rule = {
      if: { field: 'age', operator: Operator.greaterThanEqual, value: 65 },
      then: { field: 'discount', operator: Operator.equal, value: 0.2 },
      else: { field: 'discount', operator: Operator.equal, value: 0 }
    };
    
    expect(check(rule, { age: 70, discount: 0.2 })).toBe(true);
    expect(check(rule, { age: 70, discount: 0 })).toBe('discount must equal 0.2');
    expect(check(rule, { age: 30, discount: 0 })).toBe(true);
    expect(check(rule, { age: 30, discount: 0.2 })).toBe('discount must equal 0');
  });
});

describe('Array Operators', () => {
  test('empty and notEmpty', () => {
    expect(check({ field: 'items', arrayOperator: ArrayOperator.empty }, { items: [] })).toBe(true);
    expect(check({ field: 'items', arrayOperator: ArrayOperator.empty }, { items: [1] })).toBe('items must be empty');
    
    expect(check({ field: 'items', arrayOperator: ArrayOperator.notEmpty }, { items: [1] })).toBe(true);
    expect(check({ field: 'items', arrayOperator: ArrayOperator.notEmpty }, { items: [] })).toBe('items must not be empty');
  });

  test('all elements match', () => {
    const rule = {
      field: 'scores',
      arrayOperator: ArrayOperator.all,
      condition: { field: 'value', operator: Operator.greaterThan, value: 50 }
    };
    
    expect(check(rule, { scores: [{ value: 60 }, { value: 70 }, { value: 80 }] })).toBe(true);
    expect(check(rule, { scores: [{ value: 60 }, { value: 40 }] })).toBe('scores all elements must match (1 failed)');
  });

  test('any element matches', () => {
    const rule = {
      field: 'users',
      arrayOperator: ArrayOperator.any,
      condition: { field: 'role', operator: Operator.equal, value: 'admin' }
    };
    
    const data = { users: [
      { name: 'John', role: 'user' },
      { name: 'Jane', role: 'admin' },
      { name: 'Bob', role: 'user' }
    ]};
    
    expect(check(rule, data)).toBe(true);
    expect(check(rule, { users: [{ role: 'user' }, { role: 'user' }] })).toBe('users at least one element must match');
  });

  test('count-based operators', () => {
    const data = { items: [
      { active: true },
      { active: true },
      { active: false },
      { active: false }
    ]};
    
    const condition = { field: 'active', operator: Operator.equal, value: true };
    
    expect(check({ field: 'items', arrayOperator: ArrayOperator.atLeast, count: 2, condition }, data)).toBe(true);
    expect(check({ field: 'items', arrayOperator: ArrayOperator.atLeast, count: 3, condition }, data)).toBe('items at least 3 elements must match (2 matched)');
    
    expect(check({ field: 'items', arrayOperator: ArrayOperator.exactly, count: 2, condition }, data)).toBe(true);
    expect(check({ field: 'items', arrayOperator: ArrayOperator.exactly, count: 3, condition }, data)).toBe('items exactly 3 elements must match (2 matched)');
  });
});

describe('Date Operators', () => {
  test('date comparisons', () => {
    const data = { createdAt: '2024-01-15' };
    
    expect(check({ 
      field: 'createdAt', 
      dateOperator: DateOperator.after, 
      value: '2024-01-01' 
    }, data)).toBe(true);
    
    expect(check({ 
      field: 'createdAt', 
      dateOperator: DateOperator.before, 
      value: '2024-02-01' 
    }, data)).toBe(true);
    
    expect(check({ 
      field: 'createdAt', 
      dateOperator: DateOperator.before, 
      value: '2024-01-01' 
    }, data)).toContain('must be before');
  });

  test('date between', () => {
    const rule = {
      field: 'date',
      dateOperator: DateOperator.between,
      value: ['2024-01-01', '2024-12-31']
    };
    
    expect(check(rule, { date: '2024-06-15' })).toBe(true);
    expect(check(rule, { date: '2023-12-31' })).toContain('must be between');
  });

  test('day of week checking', () => {
    // Using a known Monday (2024-01-01)
    const mondayData = { date: '2024-01-01' };
    
    expect(check({
      field: 'date',
      dateOperator: DateOperator.dayIn,
      value: ['monday', 'tuesday', 'wednesday']
    }, mondayData)).toBe(true);
    
    expect(check({
      field: 'date',
      dateOperator: DateOperator.dayIn,
      value: ['saturday', 'sunday']
    }, mondayData)).toContain('must be on saturday or sunday');
  });
});

describe('Path-based Value Resolution', () => {
  test('comparing fields against each other', () => {
    const data = {
      password: 'secret123',
      confirmPassword: 'secret123',
      minLength: 8
    };
    
    expect(check({
      field: 'password',
      operator: Operator.equal,
      path: 'confirmPassword'
    }, data)).toBe(true);
    
    expect(check({
      field: 'password',
      operator: Operator.equal,
      path: 'confirmPassword'
    }, { ...data, confirmPassword: 'different' })).toBe('password must equal "different"');
  });

  test('nested path access', () => {
    const data = {
      user: {
        profile: {
          age: 25,
          settings: {
            minAge: 18
          }
        }
      }
    };
    
    expect(check({
      field: 'user.profile.age',
      operator: Operator.greaterThanEqual,
      path: 'user.profile.settings.minAge'
    }, data)).toBe(true);
  });
});

describe('Error Handling', () => {
  test('throws on invalid array field', () => {
    expect(() => check({
      field: 'notAnArray',
      arrayOperator: ArrayOperator.all,
      condition: { field: 'x', operator: Operator.equal, value: 1 }
    }, { notAnArray: 'string' })).toThrow('notAnArray must be an array');
  });

  test('throws on missing count for count-based operators', () => {
    expect(() => check({
      field: 'items',
      arrayOperator: ArrayOperator.atLeast,
      condition: { field: 'x', operator: Operator.equal, value: 1 }
    }, { items: [] })).toThrow('atLeast requires a count');
  });

  test('throws on invalid date', () => {
    expect(() => check({
      field: 'date',
      dateOperator: DateOperator.after,
      value: '2024-01-01'
    }, { date: 'not-a-date' })).toThrow('date is not a valid date');
  });

  test('throws on missing value', () => {
    expect(() => check({
      field: 'age',
      operator: Operator.greaterThan
    }, { age: 25 })).toThrow('No value or path specified');
  });
});

describe('Boolean Conditions', () => {
  test('direct boolean values', () => {
    expect(check(true, {})).toBe(true);
    expect(check(false, {})).toBe(false);
  });

  test('boolean in logical operators', () => {
    const rule = {
      all: [
        true,
        { field: 'x', operator: Operator.equal, value: 1 }
      ]
    };
    
    expect(check(rule, { x: 1 })).toBe(true);
    
    const ruleFalse = {
      all: [
        false,
        { field: 'x', operator: Operator.equal, value: 1 }
      ]
    };
    
    expect(check(ruleFalse, { x: 1 })).toBe('All conditions must pass: false AND x must equal 1');
  });
});