import { describe, expect, test } from 'bun:test';
import { check } from '../index';
import { Operator } from '../src/operator';

// FIX 1: check()'s isEmpty/notEmpty must mean "null or empty string" — matching the
// SQL backend `(field IS NULL OR field = '')` and Prisma `equals:null | equals:''`.
// lodash isEmpty(Date)/isEmpty(number) is true, which wrongly lets soft-deleted rows
// pass a `deletedAt isEmpty` grant.
describe('check() isEmpty/notEmpty — null-or-empty-string semantics', () => {
  const isEmpty = { field: 'deletedAt', operator: Operator.isEmpty } as const;
  const notEmpty = { field: 'deletedAt', operator: Operator.notEmpty } as const;

  test('a Date value is NOT empty (soft-delete grant bug)', () => {
    expect(check(isEmpty, { deletedAt: new Date('2024-01-01') })).toBe('deletedAt must be empty');
    expect(check(notEmpty, { deletedAt: new Date('2024-01-01') })).toBe(true);
  });

  test('null is empty', () => {
    expect(check(isEmpty, { deletedAt: null })).toBe(true);
    expect(check(notEmpty, { deletedAt: null })).toBe('deletedAt must not be empty');
  });

  test('undefined (missing) is empty', () => {
    expect(check(isEmpty, {})).toBe(true);
    expect(check(notEmpty, {})).toBe('deletedAt must not be empty');
  });

  test('empty string is empty', () => {
    expect(check(isEmpty, { deletedAt: '' })).toBe(true);
    expect(check(notEmpty, { deletedAt: '' })).toBe('deletedAt must not be empty');
  });

  test('number 0 is NOT empty (neither null nor empty string)', () => {
    expect(check(isEmpty, { deletedAt: 0 })).toBe('deletedAt must be empty');
    expect(check(notEmpty, { deletedAt: 0 })).toBe(true);
  });
});
