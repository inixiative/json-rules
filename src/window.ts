import { orderBy as lodashOrderBy } from 'lodash-es';
import type { ArrayRule, WindowFields } from './types';

/** True when a rule carries any windowing selector (filter/orderBy/take/skip). */
export const hasWindow = (rule: WindowFields): boolean =>
  rule.filter !== undefined ||
  !!rule.orderBy?.length ||
  rule.take !== undefined ||
  rule.skip !== undefined;

const UPPER_BOUND_OPS = new Set(['before', 'onOrBefore', 'lessThan', 'lessThanEquals']);
const LOWER_BOUND_OPS = new Set(['after', 'onOrAfter', 'greaterThan', 'greaterThanEquals']);

const conditionOpAndField = (condition: unknown): { op: string; field: string } | null => {
  if (typeof condition !== 'object' || condition === null) return null;
  const c = condition as Record<string, unknown>;
  if ('aggregate' in c) return null; // not a leaf comparison
  if (typeof c.field !== 'string') return null;
  if (typeof c.dateOperator === 'string') return { op: c.dateOperator, field: c.field };
  if (typeof c.operator === 'string') return { op: c.operator, field: c.field };
  return null;
};

/**
 * Extremal-window rewrite for compilation (toPrisma).
 *
 * When `take: 1` selects the extremal element (max via desc / min via asc) and the
 * condition compares that same ordered field with a monotonic operator, the windowed
 * predicate collapses to a plain un-windowed array rule:
 *   - all + (desc & upper-bound) | (asc & lower-bound)  ⟺  every (max/min is the bound)
 *   - any + (desc & lower-bound) | (asc & upper-bound)  ⟺  some
 * `atLeast: 1` is treated as `any`. Returns the de-windowed rule, or null when the
 * rule is windowed but not extremal-eligible (caller throws "unsupported").
 */
export const extremalRewrite = (rule: ArrayRule): ArrayRule | null => {
  if (rule.filter !== undefined) return null;
  if (rule.skip !== undefined && rule.skip !== 0) return null;
  if (rule.take !== 1) return null;
  if (!rule.orderBy || rule.orderBy.length !== 1) return null;
  const { field: orderField, dir } = rule.orderBy[0];
  if (dir !== 'asc' && dir !== 'desc') return null;

  let kind: 'all' | 'any' | null = null;
  if (rule.arrayOperator === 'all') kind = 'all';
  else if (rule.arrayOperator === 'any') kind = 'any';
  else if (rule.arrayOperator === 'atLeast' && rule.count === 1) kind = 'any';
  if (!kind) return null;

  const cof = conditionOpAndField(rule.condition);
  if (!cof || cof.field !== orderField) return null;
  const isUpper = UPPER_BOUND_OPS.has(cof.op);
  const isLower = LOWER_BOUND_OPS.has(cof.op);
  if (!isUpper && !isLower) return null;

  const max = dir === 'desc';
  const aligned =
    kind === 'all' ? (max && isUpper) || (!max && isLower) : (max && isLower) || (!max && isUpper);
  if (!aligned) return null;

  const { orderBy, take, skip, count, ...rest } = rule;
  return { ...rest, arrayOperator: kind };
};

/**
 * Apply the window pipeline to an array: filter → order → skip → take.
 * `filterFn` evaluates `rule.filter` per item and must be supplied by the caller
 * when `rule.filter` is set (window.ts stays free of the evaluator).
 * Direction comes from orderBy `dir`; take/skip are positive offsets.
 */
export const applyWindow = <T>(
  items: T[],
  rule: WindowFields,
  filterFn?: (item: T) => boolean,
): T[] => {
  let out = items;
  if (rule.filter !== undefined && filterFn) out = out.filter(filterFn);
  if (rule.orderBy?.length) {
    out = lodashOrderBy(
      out,
      rule.orderBy.map((o) => o.field),
      rule.orderBy.map((o) => o.dir),
    );
  }
  if (rule.skip !== undefined) out = out.slice(rule.skip);
  if (rule.take !== undefined) out = out.slice(0, rule.take);
  return out;
};
