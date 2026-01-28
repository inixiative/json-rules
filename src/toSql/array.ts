import type { ArrayRule } from '../types';
import { ArrayOperator } from '../operator';
import type { BuilderState } from './types';
import { quoteField } from './utils';

export const buildArrayRule = (rule: ArrayRule, state: BuilderState): string => {
  const field = quoteField(rule.field);

  switch (rule.arrayOperator) {
    case ArrayOperator.empty:
      return `(${field} IS NULL OR jsonb_array_length(${field}) = 0)`;

    case ArrayOperator.notEmpty:
      return `(${field} IS NOT NULL AND jsonb_array_length(${field}) > 0)`;

    case ArrayOperator.all:
    case ArrayOperator.any:
    case ArrayOperator.none:
    case ArrayOperator.atLeast:
    case ArrayOperator.atMost:
    case ArrayOperator.exactly:
      throw new Error(
        `Array operator '${rule.arrayOperator}' with conditions is not supported in SQL. ` +
          'Use application-level filtering for complex array operations.',
      );

    default:
      throw new Error(`Unknown array operator: ${(rule as ArrayRule).arrayOperator}`);
  }
};
