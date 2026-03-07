import { get } from 'lodash';
import { DateOperator } from '../operator';
import type { DateRule } from '../types';
import type { BuildOptions, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';

export const buildDateRule = (rule: DateRule, options?: BuildOptions): PrismaWhere => {
  const filter = buildDateLeafFilter(rule, options);
  return buildNestedFilter(rule.field, filter);
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
  const val = () => resolveDateValue(rule, options);

  switch (rule.dateOperator) {
    case DateOperator.before:
      return { lt: val() };

    case DateOperator.after:
      return { gt: val() };

    case DateOperator.onOrBefore:
      return { lte: val() };

    case DateOperator.onOrAfter:
      return { gte: val() };

    case DateOperator.between: {
      const v = val();
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('between date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(v);
      return { gte: start, lte: end };
    }

    case DateOperator.notBetween: {
      const v = val();
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('notBetween date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(v);
      return { NOT: { gte: start, lte: end } };
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
