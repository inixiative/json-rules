import { LOWER_BOUND_OPERATORS, UPPER_BOUND_OPERATORS } from './operatorCatalog';
import { readOwnPath } from './scope';
import { conditionShape } from './traverse';
import type { ArrayRule, Condition, WindowFields } from './types';

/** True when a rule carries any windowing selector (filter/orderBy/take/skip). */
export const hasWindow = (rule: WindowFields): boolean =>
  rule.filter !== undefined ||
  !!rule.orderBy?.length ||
  rule.take !== undefined ||
  rule.skip !== undefined;

const conditionOpAndField = (condition: unknown): { op: string; field: string } | null => {
  if (typeof condition !== 'object' || condition === null) return null;
  const c = condition as Record<string, unknown>;
  const shape = conditionShape(c);
  if ((shape !== 'field' && shape !== 'date') || typeof c.field !== 'string') return null;
  return { op: String(shape === 'date' ? c.dateOperator : c.operator), field: c.field };
};

/**
 * Extremal-window rewrite for compilation (toPrisma).
 *
 * When `take: 1` selects the extremal element (max via desc / min via asc; NULLs sort last, so
 * it is the extreme non-null value when there is one) and the condition compares that same
 * ordered field with a monotonic operator, the windowed predicate collapses to un-windowed
 * array rules:
 *   - any + (desc & lower-bound) | (asc & upper-bound)  ⟺  some element satisfies it
 *   - all + (desc & upper-bound) | (asc & lower-bound)  ⟺  the array is empty, or some element
 *     has a value and every element with one satisfies it
 * `atLeast: 1` is treated as `any`. Returns the de-windowed condition, or null when the
 * rule is windowed but not extremal-eligible (caller throws "unsupported").
 */
export const extremalRewrite = (rule: ArrayRule): Condition | null => {
  if (rule.filter !== undefined) return null;
  if (rule.skip !== undefined && rule.skip !== 0) return null;
  if (rule.take !== 1) return null;
  if (rule.orderBy?.length !== 1) return null;
  const { field: orderField, dir } = rule.orderBy[0];
  if (dir !== 'asc' && dir !== 'desc') return null;

  let kind: 'all' | 'any' | null = null;
  if (rule.arrayOperator === 'all') kind = 'all';
  else if (rule.arrayOperator === 'any') kind = 'any';
  else if (rule.arrayOperator === 'atLeast' && rule.count === 1) kind = 'any';
  if (!kind) return null;

  const cof = conditionOpAndField(rule.condition);
  if (!cof || cof.field !== orderField) return null;
  const isUpper = UPPER_BOUND_OPERATORS.includes(cof.op);
  const isLower = LOWER_BOUND_OPERATORS.includes(cof.op);
  if (!isUpper && !isLower) return null;

  const max = dir === 'desc';
  const aligned =
    kind === 'all' ? (max && isUpper) || (!max && isLower) : (max && isLower) || (!max && isUpper);
  if (!aligned) return null;

  const { orderBy, take, skip, count, ...rest } = rule;
  if (kind === 'any') return { ...rest, arrayOperator: 'any' } as ArrayRule;
  const present = { field: orderField, operator: 'exists' } as Condition;
  return {
    any: [
      { field: rule.field, arrayOperator: 'empty' },
      {
        all: [
          { field: rule.field, arrayOperator: 'any', condition: present },
          { ...rest, arrayOperator: 'all', condition: { if: present, then: rule.condition } },
        ],
      },
    ],
  } as Condition;
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
    const keys = rule.orderBy;
    out = [...out].sort((a, b) => {
      for (const { field, dir } of keys) {
        const order = compareNullsLast(readOwnPath(a, field), readOwnPath(b, field), dir);
        if (order !== 0) return order;
      }
      return 0;
    });
  }
  if (rule.skip !== undefined) out = out.slice(rule.skip);
  if (rule.take !== undefined) out = out.slice(0, rule.take);
  return out;
};

/** Two sort keys in `dir` order, a NULL (or absent) one last either way — the extreme element
 *  is the extreme value, as "latest" or "earliest" reads. */
const compareNullsLast = (a: unknown, b: unknown, dir: 'asc' | 'desc'): number => {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) return aNull === bNull ? 0 : aNull ? 1 : -1;
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  const order = x < y ? -1 : x > y ? 1 : 0;
  return dir === 'asc' ? order : -order;
};
