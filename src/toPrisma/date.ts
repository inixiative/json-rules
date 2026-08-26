import { get } from 'lodash-es';
import { isDateInputValue, parseDateValue, resolveTimeZone } from '../date';
import {
  isDateExpr,
  resolveDateExpr,
  resolveDateExprRange,
  resolvePointForOperator,
} from '../dateExpr';
import { DateOperator } from '../operator';
import type { DateConfig, DateRule } from '../types';
import { absentArms } from './field';
import type { BuildOptions, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';

// The negated date operators carry the `equals: null` arm (2.19.0 negation ruling) — the
// column-nullability licensing is the same as the scalar negations in ./field.ts.
const NEGATED_DATE_OPERATORS: readonly DateOperator[] = [
  DateOperator.notBefore,
  DateOperator.notAfter,
  DateOperator.notWithin,
  DateOperator.notBetween,
];

// The two range complements, hoisted to the WHERE level for the same reason as ./field.ts's
// RANGE_COMPLEMENT: Prisma distributes a field-level `not` over the nested filter's keys, so
// `{ col: { not: { gte, lte } } }` asks for `NOT(col >= a) AND NOT(col <= b)` — no row satisfies
// it, and nothing complains. The single-boundary complements (notBefore/notAfter) compile to a
// plain `gte`/`lte` and need no negation at all.
const RANGE_COMPLEMENT_DATE_OPERATORS: readonly DateOperator[] = [
  DateOperator.notWithin,
  DateOperator.notBetween,
];

const dateConfigOf = (options?: BuildOptions): DateConfig => ({
  now: options?.now,
  timeZone: options?.timeZone,
  weekStart: options?.weekStart,
});

// Literal/path date values compile through the same parse-and-anchor seam check()
// uses (naive strings → midnight in the resolved zone; instants as-is), emitted as
// concrete Dates — a raw 'YYYY-MM-DD' in a Prisma where is rejected by Prisma and
// would carry different zone semantics than check().
const coerceDateLiteral = (value: unknown, config: DateConfig): unknown => {
  if (value === undefined || !isDateInputValue(value)) return value;
  const parsed = parseDateValue(value, resolveTimeZone(config));
  if (!parsed.isValid()) throw new Error(`Invalid date value: ${String(value)}`);
  return parsed.toDate();
};

export const buildDateRule = (rule: DateRule, options?: BuildOptions): PrismaWhere => {
  const filter = buildDateLeafFilter(rule, options);
  // The leaf builder returns the POSITIVE range for the complements; the negation wraps the
  // whole clause here (see RANGE_COMPLEMENT_DATE_OPERATORS).
  const positive = buildNestedFilter(rule.field, filter);
  const nested = RANGE_COMPLEMENT_DATE_OPERATORS.includes(rule.dateOperator)
    ? { NOT: positive }
    : positive;
  // Negation keeps the absent rows — a NULL column and every NULL optional to-one hop on the
  // path; the field map licenses each arm (see absentArms).
  const arms = NEGATED_DATE_OPERATORS.includes(rule.dateOperator) ? absentArms(rule, options) : [];
  if (arms.length) return { OR: [nested, ...arms] };
  return nested;
};

/**
 * Resolve the date value for a DateRule.
 * - rule.value → use literal
 * - rule.path starting with '$.' → throw (no column-to-column in Prisma WHERE)
 * - rule.path (context ref) → look up from options.context
 */
const resolveDateValue = (rule: DateRule, options?: BuildOptions): unknown => {
  if (rule.value !== undefined) return rule.value;
  if (rule.path) {
    if (rule.path.startsWith('$.')) {
      throw new Error(
        `Prisma WHERE has no column-to-column date comparison for path '${rule.path}'. ` +
          `Use prisma.$queryRaw for field-to-field filtering.`,
      );
    }
    if (!options?.context) {
      throw new Error(
        `options.context is required to resolve date path '${rule.path}'. ` +
          `Pass context when calling toPrisma().`,
      );
    }
    return get(options.context, rule.path);
  }
  return undefined;
};

const buildDateLeafFilter = (rule: DateRule, options?: BuildOptions): unknown => {
  const config = dateConfigOf(options);
  // Point operators: resolve a date expression (operator-aware implied edges) to a
  // concrete Date at compile time, else fall back to literal/path resolution.
  const point = (): unknown =>
    isDateExpr(rule.value)
      ? resolvePointForOperator(rule.value, rule.dateOperator, config).toDate()
      : coerceDateLiteral(resolveDateValue(rule, options), config);
  const resolveElem = (el: unknown): unknown =>
    isDateExpr(el) ? resolveDateExpr(el, config).toDate() : coerceDateLiteral(el, config);

  switch (rule.dateOperator) {
    case DateOperator.before:
      return { lt: point() };

    case DateOperator.after:
      return { gt: point() };

    case DateOperator.onOrBefore:
      return { lte: point() };

    case DateOperator.onOrAfter:
      return { gte: point() };

    case DateOperator.notBefore:
      return { gte: point() };

    case DateOperator.notAfter:
      return { lte: point() };

    case DateOperator.within: {
      if (!isDateExpr(rule.value))
        throw new Error('within date operator requires a range date expression');
      const [start, end] = resolveDateExprRange(rule.value, config);
      return { gte: start.toDate(), lte: end.toDate() };
    }

    case DateOperator.notWithin: {
      if (!isDateExpr(rule.value))
        throw new Error('notWithin date operator requires a range date expression');
      const [start, end] = resolveDateExprRange(rule.value, config);
      return { gte: start.toDate(), lte: end.toDate() };
    }

    case DateOperator.between: {
      const v = resolveDateValue(rule, options);
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('between date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(v.map(resolveElem));
      return { gte: start, lte: end };
    }

    case DateOperator.notBetween: {
      const v = resolveDateValue(rule, options);
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('notBetween date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(v.map(resolveElem));
      return { gte: start, lte: end };
    }

    case DateOperator.dayIn:
      throw new Error(
        `DateOperator 'dayIn' has no Prisma equivalent. Use prisma.$queryRaw with EXTRACT(DOW FROM ...) for day-of-week filtering.`,
      );

    case DateOperator.dayNotIn:
      throw new Error(
        `DateOperator 'dayNotIn' has no Prisma equivalent. Use prisma.$queryRaw with EXTRACT(DOW FROM ...) for day-of-week filtering.`,
      );

    default:
      throw new Error(`Unknown date operator: ${(rule as DateRule).dateOperator}`);
  }
};

const normalizeDateRange = (value: unknown[]): [unknown, unknown] => {
  const [first, second] = value;
  return compareDateValues(first, second) <= 0 ? [first, second] : [second, first];
};

const compareDateValues = (left: unknown, right: unknown): number => {
  const lhs = normalizeComparableDateValue(left);
  const rhs = normalizeComparableDateValue(right);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
};

const normalizeComparableDateValue = (value: unknown): string | number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
};
