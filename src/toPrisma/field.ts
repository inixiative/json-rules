import { get } from 'lodash';
import { Operator } from '../operator';
import type { Rule } from '../types';
import { walkFieldPath } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';

export const buildFieldRule = (rule: Rule, options?: BuildOptions): PrismaWhere => {
  // isEmpty/notEmpty need OR/AND at the WHERE level (not field-filter level)
  // because Prisma 6.x rejects mixed null/string in `in`/`notIn` for nullable fields.
  if (rule.operator === Operator.isEmpty) {
    return {
      OR: [
        buildMapAwareFilter(rule.field, { equals: null }, options),
        buildMapAwareFilter(rule.field, { equals: '' }, options),
      ],
    };
  }
  if (rule.operator === Operator.notEmpty) {
    return {
      AND: [
        buildMapAwareFilter(rule.field, { not: null }, options),
        buildMapAwareFilter(rule.field, { not: '' }, options),
      ],
    };
  }

  const filter = buildLeafFilter(rule, options);
  return buildMapAwareFilter(rule.field, filter, options);
};

/**
 * Resolve the comparison value for a rule.
 * - rule.value → use literal value
 * - rule.path starting with '$.' → throw: Prisma WHERE has no column-to-column comparison
 * - rule.path (context ref) → look up from options.context via lodash get
 */
const resolveRuleValue = (rule: Rule, options?: BuildOptions): unknown => {
  if (rule.value !== undefined) return rule.value;
  if (rule.path) {
    if (rule.path.startsWith('$.')) {
      throw new Error(
        `Prisma WHERE has no column-to-column comparison for path '${rule.path}'. ` +
          `Use prisma.$queryRaw for field-to-field filtering.`,
      );
    }
    if (!options?.context) {
      throw new Error(
        `options.context is required to resolve path '${rule.path}'. ` +
          `Pass context when calling toPrisma().`,
      );
    }
    return get(options.context, rule.path);
  }
  throw new Error(`Rule for field '${rule.field}' has neither value nor path set`);
};

const buildLeafFilter = (rule: Rule, options?: BuildOptions): unknown => {
  // Lazy resolver: only called by operators that need a value
  const val = () => resolveRuleValue(rule, options);

  switch (rule.operator) {
    case Operator.equals:
      return { equals: val() ?? null };

    case Operator.notEquals:
      return { not: val() ?? null };

    case Operator.lessThan:
      return { lt: val() };

    case Operator.lessThanEquals:
      return { lte: val() };

    case Operator.greaterThan:
      return { gt: val() };

    case Operator.greaterThanEquals:
      return { gte: val() };

    case Operator.in:
      return { in: val() };

    case Operator.notIn:
      return { notIn: val() };

    case Operator.contains:
      return { contains: val() };

    case Operator.notContains:
      return { not: { contains: val() } };

    case Operator.startsWith:
      return { startsWith: val() };

    case Operator.endsWith:
      return { endsWith: val() };

    case Operator.matches:
      throw new Error(
        `Operator 'matches' has no Prisma equivalent. Use prisma.$queryRaw for regex filtering.`,
      );

    case Operator.notMatches:
      throw new Error(
        `Operator 'notMatches' has no Prisma equivalent. Use prisma.$queryRaw for regex filtering.`,
      );

    case Operator.between: {
      const v = val();
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('between operator requires an array of two values');
      }
      const [min, max] = v[0] <= v[1] ? v : [v[1], v[0]];
      return { gte: min, lte: max };
    }

    case Operator.notBetween: {
      const v = val();
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('notBetween operator requires an array of two values');
      }
      const [min, max] = v[0] <= v[1] ? v : [v[1], v[0]];
      return { NOT: { gte: min, lte: max } };
    }

    case Operator.isEmpty:
    case Operator.notEmpty:
      // Handled in buildFieldRule — should not reach here
      throw new Error('isEmpty/notEmpty handled at buildFieldRule level');

    case Operator.exists:
      return { not: null };

    case Operator.notExists:
      return { equals: null };

    default:
      throw new Error(`Unknown operator: ${(rule as Rule).operator}`);
  }
};

/**
 * Build the Prisma WHERE using map-aware traversal when a map+model is available.
 * - JSON field mid-path → Prisma JSON path syntax: { metadata: { path: ['theme'], equals: 'dark' } }
 * - All other paths → standard nested relation filter
 */
const buildMapAwareFilter = (
  field: string,
  filter: unknown,
  options?: BuildOptions,
): PrismaWhere => {
  if (!options?.map || !options?.model) {
    return buildNestedFilter(field, filter);
  }

  const walkResult = walkFieldPath(field, options.map as FieldMap, options.model);
  const parts = field.split('.');

  switch (walkResult.kind) {
    case 'fallback':
    case 'direct':
      return buildNestedFilter(field, filter);

    case 'bridge':
      return {};

    case 'json-path': {
      // Merge the json path array into the leaf filter, then nest normally
      const jsonFilter = { path: walkResult.jsonPath, ...(filter as object) };
      const fieldUpToJson = parts.slice(0, walkResult.stopIndex).join('.');
      return buildNestedFilter(fieldUpToJson, jsonFilter);
    }
  }
};
