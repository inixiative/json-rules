import { invalidValueExpression } from '../errors';
import type { Lens, LensNarrowing } from '../lens/types';
import { FieldKind } from '../operatorCatalog';
import { listItems, valueExpressionShape } from '../traverse';
import type { AggregateValue, IfThenElseValue, ValueExpression, ValueType } from '../types';
import { aggregateType } from './aggregateType';
import { isDistinct } from './distinctValues';
import { literalType } from './literalType';
import { pathType } from './pathType';
import { needLens } from './resolveValuePath';
import { listType, NULL_TYPE, unify } from './unifyValueTypes';
import { assertValidValue } from './validateValue';
import { refuse } from './valueTypeIssue';

type Lensish = Lens | LensNarrowing | undefined;

const sourceType = (node: Record<string, unknown>, lens: Lensish, path: string): ValueType => {
  if (node.value !== undefined) return literalType(node.value, `${path}.value`);
  if (typeof node.bind === 'string')
    return refuse(
      path,
      'untyped_binding',
      `{ bind: '${node.bind}' } has no type until it is bound`,
    );
  return pathType(needLens(lens, `the path '${String(node.path)}'`), node.path as string, path);
};

// In a list a missed `if` adds nothing; anywhere else it is null.
const ifType = (node: IfThenElseValue, lens: Lensish, path: string, inList: boolean): ValueType => {
  const then = inferAt(node.then, lens, `${path}.then`, inList);
  if (node.else === undefined) return inList ? then : unify(then, NULL_TYPE, path);
  return unify(then, inferAt(node.else, lens, `${path}.else`, inList), path);
};

const listOf = (expr: unknown, lens: Lensish, path: string): ValueType => {
  const type = listType(
    listItems(expr).map((item, index) => {
      const at = `${path}[${index}]`;
      const itemType = inferAt(item, lens, at, true);
      if (itemType.isList) refuse(at, 'nested_list', "a list's items are single values");
      return itemType;
    }),
    path,
  );
  if (isDistinct(expr) && type.kind === FieldKind.Json)
    refuse(`${path}.distinct`, 'distinct_over_json', 'distinct drops repeated values, not Json');
  return type;
};

const inferAt = (expr: unknown, lens: Lensish, path: string, inList: boolean): ValueType => {
  switch (valueExpressionShape(expr)) {
    case 'literal':
      return literalType(expr, path);
    case 'source':
      return sourceType(expr as Record<string, unknown>, lens, path);
    case 'aggregate':
      return aggregateType(lens, expr as AggregateValue, path);
    case 'if':
      return ifType(expr as IfThenElseValue, lens, path, inList);
    case 'list':
      return listOf(expr, lens, path);
    default:
      return refuse(path, 'invalid_value_expression', invalidValueExpression(path).message);
  }
};

/**
 * The type a value expression returns, worked out without data — for a consumer to check against
 * the type it stores before saving the expression. A literal, bare or `{ value }`, has its value's
 * kind (a whole number `Int`, any other `Float`); a path its column's kind through the lens
 * (nullable unless the map declares it required); `count` an `Int`; `sum` its column's numeric
 * kind, never null (0 over no rows); `avg` a `Float` (`Decimal` stays `Decimal`), null over no
 * rows; `min` / `max` their column's kind, nullable (no rows). An `if`'s branches and a list's
 * items must agree (two numeric kinds read as `Decimal` when either is, else `Float`; a missing
 * `else` is null). `lens` is needed wherever a path's kind is read. Throws on
 * an expression that has no type: a path that does not resolve, reads through a to-many relation
 * or names rows, an aggregate over something that isn't a list, branches that disagree, a binding,
 * `distinct` over Json.
 */
export const inferValueType = (
  expression: ValueExpression,
  lens?: Lens | LensNarrowing,
): ValueType => {
  assertValidValue(expression);
  return inferAt(expression, lens, '$', false);
};
