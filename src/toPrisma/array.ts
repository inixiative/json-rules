import type { ArrayRule, Condition } from '../types';
import { ArrayOperator } from '../operator';
import type { PrismaWhere, BuildOptions, PrismaBuildState, GroupByStep, StepRef, FieldMap, FieldMapEntry } from './types';
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
        options as BuildOptions & { map: NonNullable<BuildOptions['map']>; model: string },
        state,
      );
    }
    throw new Error(
      `ArrayOperator '${rule.arrayOperator}' requires a FieldMap and model to generate a multi-step plan. ` +
        `Pass { map, model } options to toPrisma(). Without them, use prisma.$queryRaw for count-based relation filtering.`,
    );
  }

  const filter = buildArrayLeafFilter(rule, options, state);
  return buildNestedFilter(rule.field, filter);
};

const buildArrayLeafFilter = (
  rule: ArrayRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): unknown => {
  switch (rule.arrayOperator) {
    case ArrayOperator.all:
      if (!rule.condition) throw new Error(`ArrayOperator 'all' requires a condition`);
      return { every: buildCondition(rule.condition, options, state) };

    case ArrayOperator.any:
      if (!rule.condition) throw new Error(`ArrayOperator 'any' requires a condition`);
      return { some: buildCondition(rule.condition, options, state) };

    case ArrayOperator.none:
      if (!rule.condition) throw new Error(`ArrayOperator 'none' requires a condition`);
      return { none: buildCondition(rule.condition, options, state) };

    case ArrayOperator.empty:
      return { none: {} };

    case ArrayOperator.notEmpty:
      return { some: {} };

    default:
      throw new Error(`Unknown array operator: ${(rule as ArrayRule).arrayOperator}`);
  }
};

/**
 * Generate a multi-step groupBy plan for count-based relation filtering.
 *
 * For { field: 'posts', arrayOperator: 'atLeast', count: 3, condition: ... } on User:
 *   step 0: groupBy Post by authorId where <condition> having _count >= 3
 *   where:  { id: { in: { __step: 0 } } }
 *
 * Returns null so the caller (buildArrayRule) skips the buildNestedFilter wrapper.
 * The step is pushed into state.steps and the WHERE clause is returned directly.
 */
const buildCountStep = (
  rule: ArrayRule,
  options: BuildOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  const { map, model: currentModel } = options;

  const fieldEntry = map[currentModel]?.fields[rule.field];
  if (!fieldEntry || fieldEntry.kind !== 'object') {
    throw new Error(
      `Field '${rule.field}' is not a relation in model '${currentModel}'. ` +
        `Count operators require a relation field.`,
    );
  }

  if (!fieldEntry.isList) {
    throw new Error(
      `Field '${rule.field}' is not a list relation in model '${currentModel}'. ` +
        `Count operators only apply to one-to-many or many-to-many relations.`,
    );
  }

  const targetModel = fieldEntry.type;

  // Determine the FK relationship between currentModel and targetModel.
  // For a back-relation (User.posts), the FK lives on the target (Post.authorId).
  // For a forward relation (Post.author), fromFields holds the FK on the current model.
  let fkOnTarget: string;      // column on target model that references current model
  let pkOnCurrent: string;     // column on current model being referenced

  if (fieldEntry.fromFields && fieldEntry.fromFields.length > 0) {
    // Forward relation (current model has FK) — unusual for list relations but handle it
    fkOnTarget = fieldEntry.toFields?.[0] ?? 'id';
    pkOnCurrent = fieldEntry.fromFields[0];
  } else {
    // Back-relation: FK is on the target model. Find the reverse relation.
    const reverseRelation = findReverseRelation(map, targetModel, currentModel);
    if (!reverseRelation) {
      throw new Error(
        `Cannot determine FK relationship between '${currentModel}' and '${targetModel}'. ` +
          `Ensure the FieldMap contains both sides of the relation.`,
      );
    }
    fkOnTarget = reverseRelation.fromFields![0];    // e.g. 'authorId'
    pkOnCurrent = reverseRelation.toFields![0];     // e.g. 'id'
  }

  // Build the inner WHERE for the target model
  const innerWhere = rule.condition
    ? buildCondition(rule.condition, { ...options, model: targetModel }, state)
    : {};

  const count = rule.count ?? 1;

  const having = buildHaving(rule.arrayOperator, count);

  const step: GroupByStep = {
    operation: 'groupBy',
    model: targetModel,
    args: {
      by: [fkOnTarget],
      where: innerWhere,
      having,
    },
    extract: fkOnTarget,
  };

  const stepIndex = state.steps.length;
  state.steps.push(step);

  const stepRef: StepRef = { __step: stepIndex };
  return { [pkOnCurrent]: { in: stepRef } };
};

const findReverseRelation = (
  map: FieldMap,
  targetModel: string,
  currentModel: string,
): FieldMapEntry | null => {
  const targetEntry = map[targetModel];
  if (!targetEntry) return null;

  for (const fieldDef of Object.values(targetEntry.fields)) {
    if (
      fieldDef.kind === 'object' &&
      fieldDef.type === currentModel &&
      (fieldDef.fromFields?.length ?? 0) > 0 &&
      (fieldDef.toFields?.length ?? 0) > 0
    ) {
      return fieldDef;
    }
  }
  return null;
};

const buildHaving = (
  op: ArrayOperator,
  count: number,
): Record<string, unknown> => {
  switch (op) {
    case ArrayOperator.atLeast:
      return { _count: { _all: { gte: count } } };
    case ArrayOperator.atMost:
      return { _count: { _all: { lte: count } } };
    case ArrayOperator.exactly:
      return { _count: { _all: { equals: count } } };
    default:
      throw new Error('unreachable');
  }
};
