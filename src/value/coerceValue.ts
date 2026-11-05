import type { Lens, LensNarrowing } from '../lens/types';
import { FieldKind } from '../operatorCatalog';
import { listItems, valueExpressionShape } from '../traverse';
import type { AggregateValue, ValueExpression } from '../types';
import { inferValueType } from './inferValueType';
import { assertValidValue } from './validateValue';
import { ValueTypeIssue } from './valueTypeIssue';

const READS_VALUES = ['distinct', 'min', 'max'];

// A distinct / min / max over a DateTime column reads its values as dates, so rows that carry a
// date as an ISO string (plain JSON) order and dedupe as dates. The kind comes from the lens,
// through inferValueType; an aggregate it can't type is left as it is.
const stampAggregate = (node: AggregateValue, lens: Lens | LensNarrowing): AggregateValue => {
  if (node.coerceType !== undefined || !READS_VALUES.includes(node.aggregate.mode)) return node;
  try {
    return inferValueType(node, lens).kind === FieldKind.DateTime
      ? { ...node, coerceType: FieldKind.DateTime }
      : node;
  } catch (error) {
    if (error instanceof ValueTypeIssue) return node;
    throw error;
  }
};

const coerceAt = (expr: unknown, lens: Lens | LensNarrowing): unknown => {
  switch (valueExpressionShape(expr)) {
    case 'aggregate':
      return stampAggregate(expr as AggregateValue, lens);
    case 'if': {
      const node = expr as Record<string, unknown>;
      return {
        ...node,
        then: coerceAt(node.then, lens),
        ...(node.else !== undefined && { else: coerceAt(node.else, lens) }),
      };
    }
    case 'list': {
      const items = listItems(expr).map((item) => coerceAt(item, lens));
      return Array.isArray(expr) ? items : { ...(expr as object), list: items };
    }
    default:
      return expr;
  }
};

/** Stamp the coercion a value expression's aggregates need from the lens, as `coerceRule` does for
 *  a rule's field rules: a `distinct` / `min` / `max` over a DateTime column gets
 *  `coerceType: 'DateTime'`, so ISO date strings read as dates. An aggregate that already names
 *  its coercion, or that the lens can't type, is left as it is. Non-mutating; throws on a
 *  malformed expression. */
export const coerceValue = (
  expression: ValueExpression,
  lensOrNarrowing: Lens | LensNarrowing,
): ValueExpression => {
  assertValidValue(expression);
  return coerceAt(expression, lensOrNarrowing) as ValueExpression;
};
