import { resolveExpr } from '../amount';
import { coerceDateLiteral } from '../date';
import { isDateExpr, resolveDateExprRange, resolvePointForOperator } from '../dateExpr';
import { orderPair, readPair } from '../number';
import { DateOperator } from '../operator';
import { comparatorOf, NEGATED_OPERATORS, NEGATED_RANGE_OPERATORS } from '../operatorCatalog';
import type { DateRule } from '../types';
import { absentArms, buildMapAwareFilter } from './field';
import { notLeaf, orWhere } from './logical';
import { offsetDate } from './offset';
import type { BuildOptions, PrismaWhere } from './types';
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
  if (filter === null) return orWhere(arms);
  const positive = buildMapAwareFilter(rule.field, filter, options);
  const nested = NEGATED_RANGE_OPERATORS.includes(rule.dateOperator) ? notLeaf(positive) : positive;
  return orWhere([nested, ...arms]);
};

const buildDateLeafFilter = (rule: DateRule, options?: BuildOptions): unknown => {
  const config = dateConfigOf(options);
  const read = prismaRead(options);
  const shift = (instant: Date | null): Date | null =>
    rule.offset === undefined ? instant : offsetDate(instant, rule.offset, options);
  const instantOf = (value: unknown): Date | null => {
    if (value === null || value === undefined) return null;
    if (!isDateExpr(value)) return coerceDateLiteral(value, config.timeZone);
    const expr = resolveExpr(value, read);
    return expr && resolvePointForOperator(expr, rule.dateOperator, config).toDate();
  };
  const source = () => readSource(rule, options);
  const point = (): Date | null => shift(instantOf(source()));
  const range = (): [Date, Date] | null => {
    const v = source();
    if (v === null || v === undefined) return null;
    const ends = readPair(v, rule.dateOperator).map(instantOf);
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

  const comparator = comparatorOf(rule.dateOperator, 'date');
  if (comparator) return one(comparator as 'lt' | 'gt' | 'lte' | 'gte');

  switch (rule.dateOperator) {
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
