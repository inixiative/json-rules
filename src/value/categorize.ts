import type { CheckOptions } from '../check';
import { holdsIn } from '../check';
import type { Categorization, Row, ValueExpression } from '../types';
import { evaluateValue } from './evaluateValue';

/**
 * A row's category: the value of the first case whose `if` holds (`match: 'first'`, the default;
 * later cases are not checked), or the values of every case that holds, in case order
 * (`match: 'all'`). When none holds: the `default`, a list of it under `all`; with no default,
 * null, or `[]` under `all`. Each `if` is checked as check() checks a rule and each value computed
 * as evaluateValue() computes it, with their options. A case that throws stops the categorization:
 * it never falls through to a later case or the default, which would give a value its author
 * ordered below it.
 */
export const categorize = (
  categorization: Categorization,
  row: Row,
  options: CheckOptions = {},
): unknown => {
  const opts = { ...options, scopes: [row] };
  const evaluateCase = (expression: ValueExpression) => evaluateValue(expression, row, options);
  const fallback = categorization.default;

  if (categorization.match === 'all') {
    const values = categorization.cases
      .filter((category) => holdsIn(category.if, opts))
      .map((category) => evaluateCase(category.then));
    if (values.length || fallback === undefined) return values;
    return [evaluateCase(fallback)];
  }

  const first = categorization.cases.find((category) => holdsIn(category.if, opts));
  if (first) return evaluateCase(first.then);
  return fallback === undefined ? null : evaluateCase(fallback);
};
