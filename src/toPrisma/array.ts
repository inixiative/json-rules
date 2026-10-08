import { check } from '../check';
import {
  conditionRequired,
  fieldlessArrayError,
  noCompiledForm,
  unknownOperator,
  windowUnsupported,
} from '../errors';
import { type FieldShape, ruleShape } from '../fieldMap/shape';
import type { FieldMap } from '../fieldMap/types';
import { conditionTouchesBridge, relationTarget } from '../fieldMap/walk';
import { negate } from '../negate';
import { ArrayOperator } from '../operator';
import { ARRAY_COUNT_OPERATORS, ARRAY_MONOTONE_OPERATORS } from '../operatorCatalog';
import type { AggregateRule, ArrayRule, Condition } from '../types';
import { hasWindow, windowRewrite } from '../window';
import { nestedScope } from './columnRef';
import { buildCountStep } from './countStep';
import { buildMapAwareFilter, emptinessWhere, hopArms } from './field';
import { orWhere, overFetch } from './logical';
import { buildCondition } from './recurse';
import type { PrismaBuildState, PrismaWhere, ToPrismaOptions } from './types';
import { settleLeaf } from './valueSource';

/** A rule over an array, which check() reads as empty when a to-one relation on its path is
 *  absent: where the rule holds for an empty array, so does the row with no such relation. */
export const buildArrayRule = (
  rule: ArrayRule,
  options?: ToPrismaOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  const where = compileArrayRule(rule, options, state);
  // An array held in a column carries its own absent arms (see emptinessWhere).
  return rule.field && holdsForEmpty(rule) && !isValueArray(rule.field, options)
    ? orWhere([where, ...hopArms(rule.field, options)])
    : where;
};

/** Whether a rule holds over an empty array — check() answers, as it reads one. */
export const holdsForEmpty = (rule: ArrayRule | AggregateRule): boolean =>
  check({ ...rule, field: 'items' } as Condition, { items: [] }) === true;

const compileArrayRule = (
  rule: ArrayRule,
  options?: ToPrismaOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (hasWindow(rule)) {
    const rewritten = windowRewrite(rule);
    if (!rewritten) throw windowUnsupported('toPrisma');
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
    return overFetch();

  // Count operators generate a full WHERE clause (step ref) — skip the nested-filter wrapper
  if (ARRAY_COUNT_OPERATORS.includes(rule.arrayOperator)) {
    if (options?.map && options?.model && state) {
      return buildCountStep(
        rule,
        options as ToPrismaOptions & { map: FieldMap; model: string },
        state,
      );
    }
    throw new Error(
      `ArrayOperator '${rule.arrayOperator}' requires a FieldMap and model to generate a multi-step plan. ` +
        `Pass { map, model } options to toPrisma(). Without them, use prisma.$queryRaw for count-based relation filtering.`,
    );
  }

  if (!rule.field) {
    throw fieldlessArrayError('toPrisma');
  }
  const { field } = rule;
  if (isValueArray(field, options))
    return buildValueArrayRule(
      rule,
      field,
      ruleShape({ field }, options?.map as FieldMap | undefined, options?.model),
      options,
    );
  const filter = buildArrayLeafFilter(rule, options, state);
  return buildMapAwareFilter(rule.field, filter, options);
};

const isValueArray = (field: string, options?: ToPrismaOptions): boolean => {
  const shape = ruleShape({ field }, options?.map as FieldMap | undefined, options?.model);
  return shape === 'list' || shape === 'json' || shape === 'json-path';
};

/** An array held in a column — a scalar list or a Json array. An absent or NULL one is empty,
 *  as in check(); Prisma has no filter over its elements. */
const buildValueArrayRule = (
  rule: ArrayRule,
  field: string,
  shape: FieldShape,
  options?: ToPrismaOptions,
): PrismaWhere => {
  switch (rule.arrayOperator) {
    case ArrayOperator.empty:
    case ArrayOperator.notEmpty:
      return emptinessWhere(
        field,
        shape,
        rule.arrayOperator === ArrayOperator.empty,
        false,
        options,
      );
    default:
      throw noCompiledForm(
        'toPrisma',
        `'${rule.arrayOperator}' over the ${shape === 'list' ? 'list' : 'Json array'} '${field}'`,
        shape === 'list' ? "test a list's membership with 'contains'" : undefined,
      );
  }
};

const childOptionsFor = (
  rule: ArrayRule,
  options?: ToPrismaOptions,
): ToPrismaOptions | undefined => {
  if (!options?.map || !options?.model || !rule.field)
    return options && nestedScope({ ...options });
  const target = relationTarget(rule.field, options.map as FieldMap, options.model);
  return nestedScope(target ? { ...options, model: target } : { ...options });
};

const buildArrayLeafFilter = (
  rule: ArrayRule,
  options?: ToPrismaOptions,
  state?: PrismaBuildState,
): unknown => {
  // Inner condition runs against the relation target model, not the parent.
  // Without this, JSON-path and bridge detection misfire inside some/every/none.
  const childOptions = childOptionsFor(rule, options);
  switch (rule.arrayOperator) {
    // Prisma's `every` passes a child whose condition is NULL (a NULL field), which check()
    // fails: no child in the exact complement instead.
    case ArrayOperator.all:
      if (!rule.condition) throw conditionRequired(rule.arrayOperator);
      return {
        none: buildCondition(negate(rule.condition, settleLeaf(childOptions)), childOptions, state),
      };

    case ArrayOperator.any:
      if (!rule.condition) throw conditionRequired(rule.arrayOperator);
      return { some: buildCondition(rule.condition, childOptions, state) };

    case ArrayOperator.none:
      if (!rule.condition) throw conditionRequired(rule.arrayOperator);
      return { none: buildCondition(rule.condition, childOptions, state) };

    case ArrayOperator.empty:
      return { none: {} };

    case ArrayOperator.notEmpty:
      return { some: {} };

    default:
      throw unknownOperator((rule as ArrayRule).arrayOperator, 'array');
  }
};
