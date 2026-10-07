import { describe, expect, test } from 'bun:test';
import { ArrayOperator, bindRule, type Condition, listBindings, Operator } from '../index';

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
    expect(listBindings(rule, { required: true })).toEqual(['brandUuid', 'region']);
  });

  test('empty when there are no binds', () => {
    expect(
      listBindings({ field: 'x', operator: Operator.equals, value: 1 }, { required: true }),
    ).toEqual([]);
  });
});

describe('bindRule', () => {
  test('substitutes covered binds, leaves uncovered ones as tokens (partial)', () => {
    const rule = {
      all: [
        { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' },
        { field: 'region', operator: Operator.equals, bind: 'region' },
      ],
    };
    const out = bindRule(rule, { brandUuid: 'acme-1' });
    expect(out).toEqual({
      all: [
        { field: 'brandUuid', operator: Operator.equals, value: 'acme-1' },
        { field: 'region', operator: Operator.equals, bind: 'region' },
      ],
    });
    expect(listBindings(out, { required: true })).toEqual(['region']);
  });

  test('fully resolves to a binding-free condition', () => {
    const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
    const out = bindRule(rule, { brandUuid: 'acme-1' });
    expect(out).toEqual({ field: 'brandUuid', operator: Operator.equals, value: 'acme-1' });
    expect(listBindings(out, { required: true })).toEqual([]);
  });

  test('does not mutate the input', () => {
    const rule = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
    bindRule(rule, { brandUuid: 'acme-1' });
    expect(rule).toEqual({ field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' });
  });
});

describe('the walk covers every grammar slot', () => {
  const rule: Condition = {
    all: [{ field: 'a', operator: Operator.equals, bind: 'inAll' }],
    any: [
      {
        if: { field: 'b', operator: Operator.equals, bind: 'inIf' },
        then: { field: 'c', operator: Operator.equals, bind: 'inThen' },
        else: {
          field: 'rel',
          arrayOperator: ArrayOperator.any,
          filter: { field: 'd', operator: Operator.equals, bind: 'inFilter' },
          condition: { field: 'e', operator: Operator.equals, bind: 'inCondition' },
        },
      },
    ],
  } as never;

  test('listBindings reaches all/any, if/then/else, condition and filter', () => {
    expect(listBindings(rule, { required: true })).toEqual([
      'inAll',
      'inCondition',
      'inFilter',
      'inIf',
      'inThen',
    ]);
  });

  test('bindRule substitutes in every slot', () => {
    const bindings = Object.fromEntries(
      ['inAll', 'inIf', 'inThen', 'inFilter', 'inCondition'].map((n) => [n, `${n}-v`]),
    );
    expect(listBindings(bindRule(rule, bindings), { required: true })).toEqual([]);
  });

  test('a bind whose name is an Object.prototype key does not resolve from the prototype', () => {
    const trap: Condition = { field: 'a', operator: Operator.equals, bind: 'toString' } as never;
    expect(bindRule(trap, {})).toEqual(trap);
    expect(listBindings(bindRule(trap, {}), { required: true })).toEqual(['toString']);
  });
});

describe('bindOptional — an unsupplied optional bind is null, never a missing binding', () => {
  const rule: Condition = {
    all: [
      { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' },
      { field: 'region', operator: Operator.equals, bind: 'region', bindOptional: true },
    ],
  };

  test('listBindings leaves optional names out; listBindings keeps every name', () => {
    expect(listBindings(rule, { required: true })).toEqual(['brandUuid']);
    expect(listBindings(rule)).toEqual(['brandUuid', 'region']);
  });

  test('a name optional at one leaf and required at another is required', () => {
    const mixed: Condition = {
      all: [
        { field: 'a', operator: Operator.equals, bind: 'tenant', bindOptional: true },
        { field: 'b', operator: Operator.equals, bind: 'tenant' },
      ],
    };
    expect(listBindings(mixed, { required: true })).toEqual(['tenant']);
  });

  test('bindRule drops the flag with the token it resolves, leaves an unsupplied optional token in place', () => {
    expect(bindRule(rule, { region: 'eu' })).toEqual({
      all: [
        { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' },
        { field: 'region', operator: Operator.equals, value: 'eu' },
      ],
    });
    expect(bindRule(rule, { brandUuid: 'acme' })).toEqual({
      all: [
        { field: 'brandUuid', operator: Operator.equals, value: 'acme' },
        { field: 'region', operator: Operator.equals, bind: 'region', bindOptional: true },
      ],
    });
  });
});
