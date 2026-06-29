import { describe, expect, test } from 'bun:test';
import { Operator, requiredBindings, resolveBindings } from '../index';

describe('requiredBindings', () => {
  test('collects bind names across nested all/any', () => {
    const rule = {
      all: [
        { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' },
        {
          any: [
            { field: 'region', operator: Operator.equals, bind: 'region' },
            { field: 'tier', operator: Operator.equals, value: 'gold' },
          ],
        },
      ],
    };
    expect(requiredBindings(rule)).toEqual(new Set(['brandUuid', 'region']));
  });

  test('empty when there are no binds', () => {
    expect(requiredBindings({ field: 'x', operator: Operator.equals, value: 1 })).toEqual(
      new Set(),
    );
  });
});

describe('resolveBindings', () => {
  test('substitutes covered binds, leaves uncovered ones as tokens (partial)', () => {
    const rule = {
      all: [
        { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' },
        { field: 'region', operator: Operator.equals, bind: 'region' },
      ],
    };
    const out = resolveBindings(rule, { brandUuid: 'acme-1' });
    expect(out).toEqual({
      all: [
        { field: 'brandUuid', operator: Operator.equals, value: 'acme-1' },
        { field: 'region', operator: Operator.equals, bind: 'region' },
      ],
    });
    expect(requiredBindings(out)).toEqual(new Set(['region']));
  });

  test('fully resolves to a binding-free condition', () => {
    const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
    const out = resolveBindings(rule, { brandUuid: 'acme-1' });
    expect(out).toEqual({ field: 'brandUuid', operator: Operator.equals, value: 'acme-1' });
    expect(requiredBindings(out)).toEqual(new Set());
  });

  test('does not mutate the input', () => {
    const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
    resolveBindings(rule, { brandUuid: 'acme-1' });
    expect(rule).toEqual({ field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' });
  });
});
