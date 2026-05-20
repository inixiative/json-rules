import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import { ArrayOperator, Operator } from '../src/operator';

const users = [
  { id: 'u1', industry: 'tech', status: 'active' },
  { id: 'u2', industry: 'finance', status: 'active' },
  { id: 'u3', industry: 'tech', status: 'inactive' },
];

describe('check — root array (data is array, fieldless arrayOp)', () => {
  test('any matches when at least one item satisfies', () => {
    const rule = {
      arrayOperator: ArrayOperator.any,
      condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
    };
    expect(check(rule, users)).toBe(true);
  });

  test('all fails when not every item satisfies', () => {
    const rule = {
      arrayOperator: ArrayOperator.all,
      condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
    };
    expect(typeof check(rule, users)).toBe('string');
  });

  test('atLeast 2 passes when count met', () => {
    const rule = {
      arrayOperator: ArrayOperator.atLeast,
      count: 2,
      condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
    };
    expect(check(rule, users)).toBe(true);
  });

  test('none passes when zero items match', () => {
    const rule = {
      arrayOperator: ArrayOperator.none,
      condition: { field: 'industry', operator: Operator.equals, value: 'healthcare' },
    };
    expect(check(rule, users)).toBe(true);
  });
});

describe('check — root array composed with all/any', () => {
  test('all wrapping two arrayOps both pass', () => {
    const rule = {
      all: [
        {
          arrayOperator: ArrayOperator.any,
          condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
        },
        {
          arrayOperator: ArrayOperator.atLeast,
          count: 2,
          condition: { field: 'status', operator: Operator.equals, value: 'active' },
        },
      ],
    };
    expect(check(rule, users)).toBe(true);
  });

  test('all fails when one branch fails', () => {
    const rule = {
      all: [
        {
          arrayOperator: ArrayOperator.any,
          condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
        },
        {
          arrayOperator: ArrayOperator.all,
          condition: { field: 'status', operator: Operator.equals, value: 'active' },
        },
      ],
    };
    expect(typeof check(rule, users)).toBe('string');
  });

  test('any wrapping two arrayOps passes when one matches', () => {
    const rule = {
      any: [
        {
          arrayOperator: ArrayOperator.all,
          condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
        },
        {
          arrayOperator: ArrayOperator.any,
          condition: { field: 'industry', operator: Operator.equals, value: 'finance' },
        },
      ],
    };
    expect(check(rule, users)).toBe(true);
  });
});

describe('check — root array throws on invalid rule shape', () => {
  test('top-level field-based rule throws when data is array', () => {
    const rule = { field: 'industry', operator: Operator.equals, value: 'tech' };
    expect(() => check(rule, users)).toThrow(/fieldless arrayOperator/);
  });

  test('all containing a field-based leaf throws when data is array', () => {
    const rule = {
      all: [
        {
          arrayOperator: ArrayOperator.any,
          condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
        },
        { field: 'industry', operator: Operator.equals, value: 'tech' },
      ],
    };
    expect(() => check(rule, users)).toThrow(/fieldless arrayOperator/);
  });

  test('fieldless arrayOp throws when data is not array', () => {
    const rule = {
      arrayOperator: ArrayOperator.any,
      condition: { field: 'industry', operator: Operator.equals, value: 'tech' },
    };
    expect(() => check(rule, { industry: 'tech' })).toThrow(/must be an array/);
  });
});
