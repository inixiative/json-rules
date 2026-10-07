import { describe, expect, test } from 'bun:test';
import { Operator } from '../src/operator';
import { AGGREGATE_OPERATORS, getAggregateOperators } from '../src/operatorCatalog';
import { validateRule } from '../src/validate';

const aggRule = (operator: Operator, value: unknown) => ({
  field: 'scores',
  aggregate: { mode: 'sum' as const },
  operator,
  value,
});

describe('getAggregateOperators', () => {
  test('offers every threshold comparison', () => {
    expect(getAggregateOperators()).toEqual(AGGREGATE_OPERATORS);
    expect(getAggregateOperators()).toContain(Operator.notBetween);
  });
});

describe('every target compiles every aggregate comparison', () => {
  for (const target of ['check', 'toSql', 'toPrisma'] as const)
    test(target, () => {
      expect(validateRule(aggRule(Operator.notBetween, [0, 100]), { target }).ok).toBe(true);
    });

  test('a non-aggregate operator is rejected', () => {
    const result = validateRule(aggRule(Operator.contains, 'x'), { target: 'toPrisma' });
    expect(result.errors[0].code).toBe('invalid_aggregate_operator');
  });
});
