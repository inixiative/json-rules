import { get } from 'lodash-es';
import {
  engineGlobals,
  type PrismaProvider,
  resolveCaseInsensitive,
  supportsQueryMode,
} from '../engineGlobals';
import { Operator } from '../operator';
import type { Rule } from '../types';
import { walkFieldPath } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';

// gloss
const acceptsEmptyString = (rule: Rule, options?: BuildOptions): boolean => {
  const walk =
    options?.map && options?.model
      ? walkFieldPath(rule.field, options.map as FieldMap, options.model)
      : undefined;
  const entry = walk?.kind === 'direct' ? walk.entry : undefined;
  // why: Prisma rejects equals: '' on DateTime/Int/enum columns — a widened branch turns isEmpty into a 500
  if (entry) return entry.kind === 'scalar' && (entry.type === 'String' || entry.type === 'Json');
  return (
    rule.coerceType === undefined || rule.coerceType === 'String' || rule.coerceType === 'Json'
  );
};

// gloss
export const buildFieldRule = (rule: Rule, options?: BuildOptions): PrismaWhere => {
  // why: emptiness needs OR/AND at the WHERE level — Prisma rejects mixed null/string in a field-level in/notIn
  if (rule.operator === Operator.isEmpty) {
    const isNull = buildMapAwareFilter(rule.field, { equals: null }, options);
    if (!acceptsEmptyString(rule, options)) return isNull;
    return { OR: [isNull, buildMapAwareFilter(rule.field, { equals: '' }, options)] };
  }
  if (rule.operator === Operator.notEmpty) {
    const notNull = buildMapAwareFilter(rule.field, { not: null }, options);
    if (!acceptsEmptyString(rule, options)) return notNull;
    return { AND: [notNull, buildMapAwareFilter(rule.field, { not: '' }, options)] };
  }

  const filter = buildLeafFilter(rule, options);
  return buildMapAwareFilter(rule.field, filter, options);
};

// gloss
const resolveRuleValue = (rule: Rule, options?: BuildOptions): unknown => {
  if (rule.value !== undefined) return rule.value;
  if (rule.bind !== undefined) {
    throw new Error(
      `Unresolved binding '${rule.bind}' for field '${rule.field}' — resolve bindings (resolveLensBindings) before compiling to Prisma.`,
    );
  }
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

// gloss
const buildLeafFilter = (rule: Rule, options?: BuildOptions): unknown => {
  if (rule.fuzzy)
    throw new Error(
      'Fuzzy matching has no Prisma equivalent — evaluate it in memory with check().',
    );
  const val = () => resolveRuleValue(rule, options);
  const provider = (options?.datasource?.provider ??
    engineGlobals.get('prismaOptions.datasource.provider')) as PrismaProvider;
  const ci =
    resolveCaseInsensitive(rule.caseInsensitive) && supportsQueryMode(provider)
      ? { mode: 'insensitive' as const }
      : {};

  switch (rule.operator) {
    case Operator.equals:
      return { equals: val() ?? null, ...ci };

    case Operator.notEquals:
      return { not: val() ?? null, ...ci };

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
      return { contains: val(), ...ci };

    case Operator.notContains:
      return { not: { contains: val(), ...ci } };

    case Operator.startsWith:
      return { startsWith: val(), ...ci };

    case Operator.endsWith:
      return { endsWith: val(), ...ci };

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
      throw new Error('isEmpty/notEmpty handled at buildFieldRule level');

    case Operator.exists:
      return { not: null };

    case Operator.notExists:
      return { equals: null };

    default:
      throw new Error(`Unknown operator: ${(rule as Rule).operator}`);
  }
};

// gloss
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
      const jsonFilter = { path: walkResult.jsonPath, ...(filter as object) };
      const fieldUpToJson = parts.slice(0, walkResult.stopIndex).join('.');
      return buildNestedFilter(fieldUpToJson, jsonFilter);
    }
  }
};
