import { check } from '../check';
import { negate } from '../negate';
import { ArrayOperator } from '../operator';
import { ARRAY_MONOTONE_OPERATORS } from '../operatorCatalog';
import type { AggregateRule, ArrayRule, Condition } from '../types';
import { extremalRewrite, hasWindow } from '../window';
import { buildCountStep } from './countStep';
import { buildMapAwareFilter, hopArms, nullOf } from './field';
import { orWhere } from './logical';
import { conditionTouchesBridge, type FieldShape, relationTarget, ruleShape } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';
import { settleLeaf } from './valueSource';

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

/** A rule over an array, which check() reads as empty when a to-one relation on its path is
 *  absent: where the rule holds for an empty array, so does the row with no such relation. */
export const buildArrayRule = (
  rule: ArrayRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  const where = compileArrayRule(rule, options, state);
  return rule.field && holdsForEmpty(rule)
    ? orWhere([where, ...hopArms(rule.field, options)])
    : where;
};

/** Whether a rule holds over an empty array — check() answers, as it reads one. */
export const holdsForEmpty = (rule: ArrayRule | AggregateRule): boolean =>
  check({ ...rule, field: 'items' } as Condition, { items: [] }) === true;

const compileArrayRule = (
  rule: ArrayRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (hasWindow(rule)) {
    const rewritten = extremalRewrite(rule);
    if (!rewritten) throw new Error(WINDOW_UNSUPPORTED);
    return buildCondition(rewritten, options, state);
  }

  // A condition that crosses a bridge is unknown here: unless a broader condition only widens the
  // rule, over-fetch every parent and let check() decide.
  if (
    rule.condition !== undefined &&
    !ARRAY_MONOTONE_OPERATORS.includes(rule.arrayOperator) &&
    conditionTouchesBridge(
      rule.condition,
      options?.map as FieldMap | undefined,
      childOptionsFor(rule, options)?.model,
    )
  )
    return {};

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
  const { field } = rule;
  const shape = ruleShape({ field }, options?.map as FieldMap | undefined, options?.model);
  if (shape === 'list' || shape === 'json' || shape === 'json-path')
    return buildValueArrayRule(rule, field, shape, options);
  const filter = buildArrayLeafFilter(rule, options, state);
  return buildMapAwareFilter(rule.field, filter, options);
};

/** An array held in a column — a scalar list or a Json array. An absent or NULL one is empty,
 *  as in check(); Prisma has no filter over its elements. */
const buildValueArrayRule = (
  rule: ArrayRule,
  field: string,
  shape: FieldShape,
  options?: BuildOptions,
): PrismaWhere => {
  const at = (filter: unknown) => buildMapAwareFilter(field, filter, options);
  const absent = at({ equals: nullOf(shape) });
  switch (rule.arrayOperator) {
    case ArrayOperator.empty:
      return orWhere([at(shape === 'list' ? { isEmpty: true } : { equals: [] }), absent]);
    case ArrayOperator.notEmpty:
      return shape === 'list'
        ? at({ isEmpty: false })
        : { AND: [at({ not: [] }), at({ not: nullOf(shape) })] };
    default:
      throw new Error(
        `ArrayOperator '${rule.arrayOperator}' over the ${shape === 'list' ? 'list' : 'Json array'} '${field}' has no Prisma equivalent; evaluate it with check()${shape === 'list' ? ", or test membership with 'contains'" : ''}.`,
      );
  }
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
    // Prisma's `every` passes a child whose condition is NULL (a NULL field), which check()
    // fails: no child in the exact complement instead.
    case ArrayOperator.all:
      if (!rule.condition) throw new Error(`ArrayOperator 'all' requires a condition`);
      return {
        none: buildCondition(negate(rule.condition, settleLeaf(childOptions)), childOptions, state),
      };

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
