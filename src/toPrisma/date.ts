import { resolveExpr } from '../amount';
import { coerceDateLiteral } from '../date';
import { isDateExpr, resolveDateExprRange, resolvePointForOperator } from '../dateExpr';
import { noCompiledForm, rangeExprRequired, unknownOperator } from '../errors';
import { isRelationEntry } from '../fieldMap/entry';
import { entryKind, ruleShape } from '../fieldMap/shape';
import type { FieldMap } from '../fieldMap/types';
import { fieldEntry } from '../fieldMap/walk';
import { orderPair, readPair } from '../number';
import { DateOperator } from '../operator';
import {
  comparatorOf,
  FieldKind,
  NEGATED_OPERATORS,
  NEGATED_RANGE_OPERATORS,
} from '../operatorCatalog';
import type { DateRule } from '../types';
import { absentArms, buildMapAwareFilter } from './field';
import { notLeaf, orWhere } from './logical';
import { offsetDate } from './offset';
import type { PrismaWhere, ToPrismaOptions } from './types';
import { dateConfigOf, prismaRead, readSource } from './valueSource';

// Negated date operators keep NULL rows, as the scalar negations in ./field.ts do. A range
// complement is a WHERE-level NOT: a field-level `not` over `{ gte, lte }` distributes over both
// keys and matches nothing.
export const buildDateRule = (rule: DateRule, options?: ToPrismaOptions): PrismaWhere => {
  // Prisma filters a date only on a DateTime column: Json and String compare text, a number a
  // number.
  const map = options?.map as FieldMap | undefined;
  const shape = ruleShape({ field: rule.field }, map, options?.model);
  if (shape === 'json' || shape === 'json-path')
    throw noCompiledForm(
      'toPrisma',
      `A date rule on the Json value '${rule.field}'`,
      'Prisma compares Json text',
    );
  const entry = fieldEntry(rule.field, map, options?.model);
  if (entry && !isRelationEntry(entry) && entryKind(entry) !== FieldKind.DateTime)
    throw noCompiledForm(
      'toPrisma',
      `A date rule on the ${entry.type} field '${rule.field}'`,
      `Prisma compares it as ${entry.type}, not as an instant`,
    );
  const arms = NEGATED_OPERATORS.includes(rule.dateOperator) ? absentArms(rule, options) : [];
  const filter = buildDateLeafFilter(rule, options);
  // Nothing to compare against — a null path, bind, offset or magnitude: no row matches, and a
  // negation keeps the absent rows only, as on the other rails.
  if (filter === null) return orWhere(arms);
  const positive = buildMapAwareFilter(rule.field, filter, options);
  const nested = NEGATED_RANGE_OPERATORS.includes(rule.dateOperator) ? notLeaf(positive) : positive;
  return orWhere([nested, ...arms]);
};

const buildDateLeafFilter = (rule: DateRule, options?: ToPrismaOptions): unknown => {
  const config = dateConfigOf(options);
  const read = prismaRead;
  const shift = (instant: Date | null): Date | null =>
    rule.offset === undefined ? instant : offsetDate(instant, rule.offset, options);
  const instantOf = (value: unknown): Date | null => {
    if (value === null || value === undefined) return null;
    if (!isDateExpr(value)) return coerceDateLiteral(value, config.timeZone);
    const expr = resolveExpr(value, read);
    return expr && resolvePointForOperator(expr, rule.dateOperator, config).toDate();
  };
  const source = () => readSource(rule);
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
    if (!isDateExpr(v)) throw rangeExprRequired(rule.dateOperator);
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
    case DateOperator.dayNotIn:
      throw noCompiledForm('toPrisma', `'${rule.dateOperator}'`);

    default:
      throw unknownOperator((rule as DateRule).dateOperator, 'date');
  }
};
