import dayjs from 'dayjs';
import { isDateInputValue, parseDateValue, resolveTimeZone } from '../date';
import {
  isDateExpr,
  resolveDateExprRange,
  resolvePointForOperator,
  rollingShift,
  shiftByUnits,
} from '../dateExpr';
import { DateOperator } from '../operator';
import type { DateConfig, DateRule } from '../types';
import { resolveExpr, resolveUnits } from '../valueSource';
import { absentArms } from './field';
import { matchNothing } from './logical';
import type { BuildOptions, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';
import { amountReader, readPathValue } from './valueSource';

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
  const arms = NEGATED_DATE_OPERATORS.includes(rule.dateOperator) ? absentArms(rule, options) : [];
  const filter = buildDateLeafFilter(rule, options);
  // Nothing to compare against — a null path, bind, offset or magnitude: no row matches, and a
  // negation keeps the absent rows only, as on the other rails.
  if (filter === null) {
    if (!arms.length) return matchNothing();
    return arms.length === 1 ? arms[0] : { OR: arms };
  }
  const positive = buildNestedFilter(rule.field, filter);
  const nested = RANGE_COMPLEMENT_DATE_OPERATORS.includes(rule.dateOperator)
    ? { NOT: positive }
    : positive;
  if (arms.length) return { OR: [nested, ...arms] };
  return nested;
};

/** The comparison value before any offset: a literal or expression, a context path, a bind. */
const resolveDateValue = (rule: DateRule, options?: BuildOptions): unknown => {
  if (rule.value !== undefined) return rule.value;
  if (rule.path) return readPathValue(rule.path, options);
  if (rule.bind !== undefined) {
    if (rule.bindOptional === true) return null;
    throw new Error(
      `Unresolved binding '${rule.bind}' for field '${rule.field}' — resolve bindings (resolveLensBindings) before compiling to Prisma.`,
    );
  }
  return undefined;
};

const buildDateLeafFilter = (rule: DateRule, options?: BuildOptions): unknown => {
  const config = dateConfigOf(options);
  const read = amountReader(options);

  const shift = (instant: Date | null): Date | null => {
    if (instant === null || rule.offset === undefined) return instant;
    const shift = rollingShift(rule.offset);
    if (!shift) throw new Error('a date offset is { ago } or { ahead }');
    const [raw, direction] = shift;
    const units = resolveUnits(raw, read);
    return units && shiftByUnits(dayjs(instant), units, direction).toDate();
  };
  const instantOf = (value: unknown, operator: string): Date | null => {
    if (value === null || value === undefined) return null;
    if (isDateExpr(value)) {
      const expr = resolveExpr(value, read);
      return expr && resolvePointForOperator(expr, operator, config).toDate();
    }
    return coerceDateLiteral(value, config) as Date;
  };
  const point = (): Date | null =>
    shift(instantOf(resolveDateValue(rule, options), rule.dateOperator));
  const range = (): [Date, Date] | null => {
    const v = resolveDateValue(rule, options);
    if (v === null) return null;
    if (!Array.isArray(v) || v.length !== 2) {
      throw new Error(`${rule.dateOperator} date operator requires an array of two values`);
    }
    const ends = v.map((el) => instantOf(el, rule.dateOperator));
    if (ends[0] === null || ends[1] === null) return null;
    const [start, end] = normalizeDateRange(ends) as [Date, Date];
    const shiftedStart = shift(start);
    const shiftedEnd = shift(end);
    return shiftedStart && shiftedEnd ? [shiftedStart, shiftedEnd] : null;
  };
  const window = (): [Date, Date] | null => {
    const v = resolveDateValue(rule, options);
    if (v === null) return null;
    if (!isDateExpr(v))
      throw new Error(`${rule.dateOperator} date operator requires a range date expression`);
    const expr = resolveExpr(v, read);
    if (!expr) return null;
    const [start, end] = resolveDateExprRange(expr, config);
    return [start.toDate(), end.toDate()];
  };
  const one = (key: 'lt' | 'gt' | 'lte' | 'gte') => {
    const at = point();
    return at === null ? null : { [key]: at };
  };
  const two = (ends: [Date, Date] | null) => (ends ? { gte: ends[0], lte: ends[1] } : null);

  switch (rule.dateOperator) {
    case DateOperator.before:
      return one('lt');

    case DateOperator.after:
      return one('gt');

    case DateOperator.onOrBefore:
      return one('lte');

    case DateOperator.onOrAfter:
      return one('gte');

    case DateOperator.notBefore:
      return one('gte');

    case DateOperator.notAfter:
      return one('lte');

    case DateOperator.within:
    case DateOperator.notWithin:
      return two(window());

    case DateOperator.between:
    case DateOperator.notBetween:
      return two(range());

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
