import { describe, expect, test } from 'bun:test';
import { check, Operator } from '../index';

describe('bind values (context-bind tokens)', () => {
  test('resolves a bind from options.bindings (equality)', () => {
    const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
    expect(check(rule, { brandUuid: 'abc' }, { bindings: { brandUuid: 'abc' } })).toBe(true);
    expect(check(rule, { brandUuid: 'xyz' }, { bindings: { brandUuid: 'abc' } })).toBe(
      'brandUuid must equal "abc"',
    );
  });

  test('bind works for an ordered comparison', () => {
    const rule = { field: 'age', operator: Operator.greaterThanEquals, bind: 'minAge' };
    expect(check(rule, { age: 25 }, { bindings: { minAge: 18 } })).toBe(true);
    expect(check(rule, { age: 16 }, { bindings: { minAge: 18 } })).not.toBe(true);
  });

  test('throws when a referenced bind is missing from the map', () => {
    const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
    expect(() => check(rule, { brandUuid: 'abc' }, { bindings: {} })).toThrow('brandUuid');
    expect(() => check(rule, { brandUuid: 'abc' })).toThrow('brandUuid');
  });
});
