import { resolveExpr } from '../amount';
import { coerceDateLiteral } from '../date';
import { isDateExpr, resolveDateExprRange, resolvePointForOperator, zoneOf } from '../dateExpr';
import { orderPair } from '../number';
import { DateOperator } from '../operator';
import { NEGATED_OPERATORS, NEGATED_RANGE_OPERATORS } from '../operatorCatalog';
import type { DateRule } from '../types';
import { absentArms } from './field';
import { matchNothing } from './logical';
import { offsetDate } from './offset';
import type { BuildOptions, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';
import { dateConfigOf, prismaRead, readSource } from './valueSource';

// The negated date operators carry the `equals: null` arm (2.19.0 negation ruling) — the
// column-nullability licensing is the same as the scalar negations in ./field.ts.
// The two range complements, hoisted to the WHERE level for the same reason as ./field.ts's
// NEGATED_RANGE_OPERATORS: Prisma distributes a field-level `not` over the nested filter's keys, so
// `{ col: { not: { gte, lte } } }` asks for `NOT(col >= a) AND NOT(col <= b)` — no row satisfies
// it, and nothing complains. The single-boundary complements (notBefore/notAfter) compile to a
// plain `gte`/`lte` and need no negation at all.
export const buildDateRule = (rule: DateRule, options?: BuildOptions): PrismaWhere => {
  const arms = NEGATED_OPERATORS.includes(rule.dateOperator) ? absentArms(rule, options) : [];
  const filter = buildDateLeafFilter(rule, options);
  // Nothing to compare against — a null path, bind, offset or magnitude: no row matches, and a
  // negation keeps the absent rows only, as on the other rails.
  if (filter === null) {
    if (!arms.length) return matchNothing();
    return arms.length === 1 ? arms[0] : { OR: arms };
  }
  const positive = buildNestedFilter(rule.field, filter);
  const nested = NEGATED_RANGE_OPERATORS.includes(rule.dateOperator) ? { NOT: positive } : positive;
  if (arms.length) return { OR: [nested, ...arms] };
  return nested;
};

const buildDateLeafFilter = (rule: DateRule, options?: BuildOptions): unknown => {
  const config = dateConfigOf(options);
  const read = prismaRead(options);
  const shift = (instant: Date | null): Date | null =>
    rule.offset === undefined ? instant : offsetDate(instant, rule.offset, options);
  const instantOf = (value: unknown): Date | null => {
    if (value === null || value === undefined) return null;
    if (!isDateExpr(value)) return coerceDateLiteral(value, zoneOf(config));
    const expr = resolveExpr(value, read);
    return expr && resolvePointForOperator(expr, rule.dateOperator, config).toDate();
  };
  const source = () => readSource(rule, options);
  const point = (): Date | null => shift(instantOf(source()));
  const range = (): [Date, Date] | null => {
    const v = source();
    if (v === null || v === undefined) return null;
    if (!Array.isArray(v) || v.length !== 2) {
      throw new Error(`${rule.dateOperator} date operator requires an array of two values`);
    }
    const ends = v.map(instantOf);
    if (ends[0] === null || ends[1] === null) return null;
    const [start, end] = orderPair(ends as Date[]).map(shift);
    return start && end ? [start, end] : null;
  };
  const window = (): [Date, Date] | null => {
    const v = source();
    if (v === null || v === undefined) return null;
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
