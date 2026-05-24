import { ArrayOperator } from '../operator';
import type { ArrayRule, Condition } from '../types';
import { buildCountStep } from './countStep';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';

// Forward declaration - provided by condition.ts to avoid circular import
type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;
let buildCondition: BuildConditionFn;

export const setConditionBuilderForArray = (fn: BuildConditionFn) => {
  buildCondition = fn;
};

export const buildArrayRule = (
  rule: ArrayRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  // Count operators generate a full WHERE clause (step ref) — skip the nested-filter wrapper
  if (
    rule.arrayOperator === ArrayOperator.atLeast ||
    rule.arrayOperator === ArrayOperator.atMost ||
    rule.arrayOperator === ArrayOperator.exactly
  ) {
    if (options?.map && options?.model && state) {
      return buildCountStep(
        rule,
        options as BuildOptions & { map: FieldMap; model: string },
        state,
        buildCondition,
      );
    }
    throw new Error(
      `ArrayOperator '${rule.arrayOperator}' requires a FieldMap and model to generate a multi-step plan. ` +
        `Pass { map, model } options to toPrisma(). Without them, use prisma.$queryRaw for count-based relation filtering.`,
    );
  }

  if (!rule.field) {
    throw new Error('toPrisma: ArrayRule.field is required (fieldless arrayOps are check-only)');
  }
  const filter = buildArrayLeafFilter(rule, options, state);
  return buildNestedFilter(rule.field, filter);
};

/**
 * Walk a relation field path and return the target model name, so inner conditions
 * resolve against the right model (enables JSON-path and bridge detection inside
 * some/every/none). Returns null if the path isn't a chain of object relations.
 */
const resolveRelationTarget = (field: string, map: FieldMap, rootModel: string): string | null => {
  const parts = field.split('.');
  let cur = rootModel;
  for (const part of parts) {
    const entry = map[cur]?.fields[part];
    if (!entry || entry.kind !== 'object') return null;
    cur = entry.type;
  }
  return cur;
};

const childOptionsFor = (rule: ArrayRule, options?: BuildOptions): BuildOptions | undefined => {
  if (!options?.map || !options?.model || !rule.field) return options;
  const target = resolveRelationTarget(rule.field, options.map as FieldMap, options.model);
  return target ? { ...options, model: target } : options;
};

const buildArrayLeafFilter = (
  rule: ArrayRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): unknown => {
  // Inner condition runs against the relation target model, not the parent.
  // Without this, JSON-path and bridge detection misfire inside some/every/none.
  const childOptions = childOptionsFor(rule, options);
  switch (rule.arrayOperator) {
    case ArrayOperator.all:
      if (!rule.condition) throw new Error(`ArrayOperator 'all' requires a condition`);
      return { every: buildCondition(rule.condition, childOptions, state) };

    case ArrayOperator.any:
      if (!rule.condition) throw new Error(`ArrayOperator 'any' requires a condition`);
      return { some: buildCondition(rule.condition, childOptions, state) };

    case ArrayOperator.none:
      if (!rule.condition) throw new Error(`ArrayOperator 'none' requires a condition`);
      return { none: buildCondition(rule.condition, childOptions, state) };

    case ArrayOperator.empty:
      return { none: {} };

    case ArrayOperator.notEmpty:
      return { some: {} };

    default:
      throw new Error(`Unknown array operator: ${(rule as ArrayRule).arrayOperator}`);
  }
};
