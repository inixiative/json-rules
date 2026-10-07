import { ArrayOperator } from '../operator';
import type { ArrayRule, Condition } from '../types';
import { extremalRewrite, hasWindow } from '../window';
import { buildCountStep } from './countStep';
import { buildMapAwareFilter } from './field';
import { relationTarget } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';

const WINDOW_UNSUPPORTED =
  'Windowing (orderBy/take/skip) is not supported by toPrisma() for this rule; ' +
  'only extremal (take:1, single orderBy on the compared field, aligned direction) ' +
  'rewrites to every/some. Evaluate other windowed rules with check().';

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
  if (hasWindow(rule)) {
    const rewritten = extremalRewrite(rule);
    if (!rewritten) throw new Error(WINDOW_UNSUPPORTED);
    return buildArrayRule(rewritten, options, state);
  }

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
  return buildMapAwareFilter(rule.field, filter, options);
};

const childOptionsFor = (rule: ArrayRule, options?: BuildOptions): BuildOptions | undefined => {
  if (!options?.map || !options?.model || !rule.field) return options;
  const target = relationTarget(rule.field, options.map as FieldMap, options.model);
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
