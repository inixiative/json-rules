import { describe, expect, test } from 'bun:test';
import { check, Operator } from '../index';

describe('Basic Validation Examples', () => {
  test('age validation', () => {
    const ageRule = {
      field: 'age',
      operator: Operator.greaterThanEqual,
      value: 18,
      error: 'You must be 18 or older to register'
    };

    expect(check(ageRule, { age: 21 })).toBe(true);
    expect(check(ageRule, { age: 16 })).toBe('You must be 18 or older to register');
  });

  test('email validation with regex', () => {
    const emailRule = {
      field: 'email',
      operator: Operator.match,
      value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
      error: 'Please enter a valid email address'
    };

    expect(check(emailRule, { email: 'user@example.com' })).toBe(true);
    expect(check(emailRule, { email: 'invalid-email' })).toBe('Please enter a valid email address');
  });

  test('range validation', () => {
    const scoreRule = {
      field: 'score',
      operator: Operator.between,
      value: [0, 100],
      error: 'Score must be between 0 and 100'
    };

    expect(check(scoreRule, { score: 85 })).toBe(true);
    expect(check(scoreRule, { score: 150 })).toBe('Score must be between 0 and 100');
  });

  test('membership check', () => {
    const roleRule = {
      field: 'role',
      operator: Operator.in,
      value: ['admin', 'editor', 'viewer'],
      error: 'Invalid role selected'
    };

    expect(check(roleRule, { role: 'admin' })).toBe(true);
    expect(check(roleRule, { role: 'guest' })).toBe('Invalid role selected');
  });

  test('string operations', () => {
    const urlRule = {
      field: 'website',
      operator: Operator.startsWith,
      value: 'https://',
      error: 'Website must use HTTPS'
    };

    expect(check(urlRule, { website: 'https://example.com' })).toBe(true);
    expect(check(urlRule, { website: 'http://example.com' })).toBe('Website must use HTTPS');
  });

  test('existence checks', () => {
    const phoneRule = {
      field: 'phone',
      operator: Operator.notEmpty,
      error: 'Phone number is required'
    };

    expect(check(phoneRule, { phone: '+1-555-0123' })).toBe(true);
    expect(check(phoneRule, { phone: '' })).toBe('Phone number is required');
    expect(check(phoneRule, { phone: null })).toBe('Phone number is required');
  });
});