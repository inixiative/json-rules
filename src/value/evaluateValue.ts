import { resolveExpr } from '../amount';
import type { CheckOptions, EvalOptions } from '../check';
import { holdsIn } from '../check';
import { clockFloorError } from '../clock';
import { coerceDateLiteral, coercionZone, resolveDateConfig } from '../date';
import { isDateExpr, type ResolvedDateConfig, resolveDateExprInstant } from '../dateExpr';
import { invalidValueExpression, valueTakesNoComparison } from '../errors';
import { addOffset, applyDateOffset, offsetAmount } from '../offset';
import { isCoercedLiteral, listItems, valueExpressionShape } from '../traverse';
import type {
  AggregateValue,
  CoercedLiteral,
  DateExpr,
  IfThenElseValue,
  Row,
  ValueExpression,
  ValueSourceFields,
} from '../types';
import { type ReadSource, readValueSource } from '../valueSource';
import { coerceAggregateValue } from './coerceAggregateValue';
import { distinctValues, isDistinct } from './distinctValues';
import { evaluateAggregateValue } from './evaluateAggregateValue';
import { namesComparison } from './namesComparison';

type Branch = { expr: unknown; path: string };

const makeRead =
  (opts: EvalOptions): ReadSource =>
  (source) =>
    readValueSource(source, opts.scopes, opts.bindings);

const resolveDate = (expr: DateExpr, config: ResolvedDateConfig, read: ReadSource): Date | null => {
  const resolved = resolveExpr(expr, read);
  return resolved ? resolveDateExprInstant(resolved, config) : null;
};

// A literal read as its `coerceType`, as an aggregate reads its values: a list literal item by
// item. A value the kind can't read stays as it is.
const coercedLiteral = (node: CoercedLiteral, opts: EvalOptions): unknown => {
  const coerce = coerceAggregateValue(node.coerceType, coercionZone(node.coerceType, opts));
  return Array.isArray(node.value) ? node.value.map(coerce) : coerce(node.value);
};

const evaluateDateExpr = (expr: DateExpr, opts: EvalOptions): Date | null => {
  const clockError = clockFloorError(expr);
  if (clockError) throw clockError;
  const read = makeRead(opts);
  return resolveDate(expr, resolveDateConfig(opts, read), read);
};

const evaluateSource = (node: Record<string, unknown>, opts: EvalOptions): unknown => {
  const base = isCoercedLiteral(node)
    ? coercedLiteral(node, opts)
    : readValueSource(node as ValueSourceFields<unknown>, opts.scopes, opts.bindings);
  if (node.offset === undefined) return base;

  const read = makeRead(opts);
  const rawOffset = readValueSource(
    node.offset as ValueSourceFields<unknown>,
    opts.scopes,
    opts.bindings,
  );
  const clockError = clockFloorError(base, rawOffset);
  if (clockError) throw clockError;
  if (base === null || base === undefined || rawOffset === null || rawOffset === undefined)
    return null;

  if (isDateExpr(rawOffset)) {
    const config = resolveDateConfig(opts, read);
    const date = isDateExpr(base)
      ? resolveDate(base, config, read)
      : coerceDateLiteral(base, config.timeZone);
    return date ? applyDateOffset(date, rawOffset, read, config.timeZone) : null;
  }

  return addOffset(base, offsetAmount(rawOffset) as number);
};

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
    case 'date':
      return evaluateDateExpr(expr as DateExpr, opts);
    case 'source':
      return evaluateSource(expr as Record<string, unknown>, opts);
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
 * `now`, `timeZone`, `weekStart`, `absent`): a literal (bare, `{ value }`, or `{ value, coerceType }`
 * read as that kind), a date expression (`{ ahead }`, `{ ago }`, `{ this/last/next }` — its start
 * instant — or `{ start/end }`), a path read (null when absent), a bound value — each source
 * optionally shifted by `offset` (a rolling date shift or a number) — an aggregate over a
 * relation's rows (`count`, `sum`, `avg`, `min`, `max`, through its window and condition; `avg`
 * and `min` / `max` over no values are null), the branch an `if` picks, or a list (`distinct: true`
 * drops repeats). Throws on a malformed expression, as check() throws on a malformed rule;
 * `validateValue` reports every problem without data.
 */
export const evaluateValue = (
  expression: ValueExpression,
  data: Row,
  options: CheckOptions = {},
): unknown => evaluateAt(expression, { ...options, scopes: [data] }, '$');
