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
  test('no target offers every threshold comparison', () => {
    expect(getAggregateOperators()).toEqual(AGGREGATE_OPERATORS);
  });

  test('toPrisma drops notBetween — its having filter has no range complement', () => {
    expect(getAggregateOperators('toPrisma')).not.toContain(Operator.notBetween);
    expect(getAggregateOperators('toPrisma')).toContain(Operator.between);
  });

  test('check and toSql keep it', () => {
    expect(getAggregateOperators('check')).toContain(Operator.notBetween);
    expect(getAggregateOperators('toSql')).toContain(Operator.notBetween);
  });
});

describe('the validator rejects on the same list', () => {
  test('toPrisma rejects notBetween', () => {
    const result = validateRule(aggRule(Operator.notBetween, [0, 100]), { target: 'toPrisma' });
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('unsupported_prisma_aggregate_operator');
  });

  test('toSql accepts it', () => {
    expect(validateRule(aggRule(Operator.notBetween, [0, 100]), { target: 'toSql' }).ok).toBe(true);
  });

  test('check accepts it', () => {
    expect(validateRule(aggRule(Operator.notBetween, [0, 100]), { target: 'check' }).ok).toBe(true);
  });
});
