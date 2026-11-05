import type { CheckOptions, EvalOptions } from '../check';
import { holdsIn } from '../check';
import { invalidValueExpression, valueTakesNoComparison } from '../errors';
import { listItems, valueExpressionShape } from '../traverse';
import type {
  AggregateValue,
  IfThenElseValue,
  Row,
  ValueExpression,
  ValueSourceFields,
} from '../types';
import { readValueSource } from '../valueSource';
import { distinctValues, isDistinct } from './distinctValues';
import { evaluateAggregateValue } from './evaluateAggregateValue';
import { namesComparison } from './namesComparison';

type Branch = { expr: unknown; path: string };

// The branch an `if` picks: `then` when its condition holds, else `else` — undefined when there is
// none.
const pickBranch = (node: IfThenElseValue, opts: EvalOptions, path: string): Branch | undefined => {
  if (node.if === undefined || node.then === undefined)
    throw new Error(`${path}: if / then takes both an if and a then`);
  if (holdsIn(node.if, opts)) return { expr: node.then, path: `${path}.then` };
  return node.else === undefined ? undefined : { expr: node.else, path: `${path}.else` };
};

const evaluateIf = (node: IfThenElseValue, opts: EvalOptions, path: string): unknown => {
  const branch = pickBranch(node, opts, path);
  return branch === undefined ? null : evaluateAt(branch.expr, opts, branch.path);
};

// Each item in turn; an `if` with no `else` that doesn't hold adds nothing.
const evaluateList = (expr: unknown, opts: EvalOptions, path: string): unknown[] => {
  if (!Array.isArray(expr) && !Array.isArray((expr as { list?: unknown }).list))
    throw new Error(`${path}.list must be an array`);
  const values = listItems(expr).flatMap((item, index) => {
    const at = `${path}[${index}]`;
    const shape = valueExpressionShape(item);
    if (shape === 'list') throw new Error(`${at}: a list's items are single values`);
    if (shape !== 'if') return [evaluateAt(item, opts, at)];
    const branch = pickBranch(item as IfThenElseValue, opts, at);
    return branch === undefined ? [] : [evaluateAt(branch.expr, opts, branch.path)];
  });
  return isDistinct(expr) ? distinctValues(values) : values;
};

const evaluateAt = (expr: unknown, opts: EvalOptions, path: string): unknown => {
  switch (valueExpressionShape(expr)) {
    case 'literal':
      return expr;
    case 'source':
      return readValueSource(expr as ValueSourceFields<unknown>, opts.scopes, opts.bindings);
    case 'aggregate':
      return evaluateAggregateValue(expr as AggregateValue, opts, path);
    case 'if':
      return evaluateIf(expr as IfThenElseValue, opts, path);
    case 'list':
      return evaluateList(expr, opts, path);
    default:
      throw namesComparison(expr) ? valueTakesNoComparison(path) : invalidValueExpression(path);
  }
};

/**
 * The value an expression computes from a row, in memory, with what check() takes (`bindings`,
 * `now`, `timeZone`, `weekStart`, `absent`): a literal (bare or `{ value }`), a path read (null when absent), a bound
 * value, an aggregate over a relation's rows (`count`, `sum`, `avg`, `min`, `max`, through its
 * window and condition; `avg` and `min` / `max` over no values are null), the branch an `if` picks,
 * or a list (`distinct: true` drops repeats). Throws on a malformed expression,
 * as check() throws on a malformed rule; `validateValue` reports every problem without data.
 */
export const evaluateValue = (
  expression: ValueExpression,
  data: Row,
  options: CheckOptions = {},
): unknown => evaluateAt(expression, { ...options, scopes: [data] }, '$');
