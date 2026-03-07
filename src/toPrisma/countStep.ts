import { ArrayOperator } from '../operator';
import type { ArrayRule, Condition } from '../types';
import type {
  BuildOptions,
  FieldMap,
  FieldMapEntry,
  GroupByStep,
  PrismaBuildState,
  PrismaWhere,
  StepRef,
} from './types';

type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;

/**
 * Generate a multi-step groupBy plan for count-based relation filtering.
 *
 * For { field: 'posts', arrayOperator: 'atLeast', count: 3, condition: ... } on User:
 *   step 0: groupBy Post by authorId where <condition> having _count >= 3
 *   where:  { id: { in: { __step: 0 } } }
 *
 * The step is pushed into state.steps and the WHERE clause is returned directly.
 */
export const buildCountStep = (
  rule: ArrayRule,
  options: BuildOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
  buildCondition: BuildConditionFn,
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

  let fkOnTarget: string;
  let pkOnCurrent: string;

  if (fieldEntry.fromFields && fieldEntry.fromFields.length > 0) {
    // Forward relation (current model has FK) — unusual for list relations but handle it
    if (fieldEntry.fromFields.length > 1) {
      throw new Error(
        `Count operators (atLeast/atMost/exactly) do not support composite FK relations ` +
          `('${currentModel}.${rule.field}'). Use prisma.$queryRaw for composite FK count filtering.`,
      );
    }
    fkOnTarget = fieldEntry.toFields?.[0] ?? 'id';
    pkOnCurrent = fieldEntry.fromFields[0];
  } else {
    // Back-relation: FK is on the target model. Find the reverse relation.
    const reverseRelation = findReverseRelation(
      map,
      targetModel,
      currentModel,
      fieldEntry.relationName,
    );
    if (!reverseRelation) {
      const targetFields = Object.values(map[targetModel]?.fields ?? {});
      const isImplicitM2M = targetFields.some(
        (f) => f.kind === 'object' && f.type === currentModel && f.isList && !f.fromFields?.length,
      );
      throw new Error(
        isImplicitM2M
          ? `'${currentModel}.${rule.field}' is an implicit many-to-many relation. ` +
              `Count operators require an explicit join model with a FK — convert to an explicit ` +
              `@relation or use prisma.$queryRaw.`
          : `Cannot determine FK relationship between '${currentModel}' and '${targetModel}'. ` +
              `Ensure the FieldMap contains both sides of the relation.`,
      );
    }
    if ((reverseRelation.fromFields?.length ?? 0) > 1) {
      throw new Error(
        `Count operators (atLeast/atMost/exactly) do not support composite FK relations ` +
          `('${currentModel}.${rule.field}'). Use prisma.$queryRaw for composite FK count filtering.`,
      );
    }
    fkOnTarget = reverseRelation.fromFields?.[0] ?? '';
    pkOnCurrent = reverseRelation.toFields?.[0] ?? '';
  }

  const innerWhere = rule.condition
    ? buildCondition(rule.condition, { ...options, model: targetModel }, state)
    : {};

  const count = rule.count ?? 1;
  const having = buildHaving(rule.arrayOperator, count);

  const step: GroupByStep = {
    operation: 'groupBy',
    model: targetModel,
    args: { by: [fkOnTarget], where: innerWhere, having },
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
  relationName?: string,
): FieldMapEntry | null => {
  const targetEntry = map[targetModel];
  if (!targetEntry) return null;

  for (const fieldDef of Object.values(targetEntry.fields)) {
    if (
      fieldDef.kind === 'object' &&
      fieldDef.type === currentModel &&
      (fieldDef.fromFields?.length ?? 0) > 0 &&
      (fieldDef.toFields?.length ?? 0) > 0 &&
      (relationName === undefined || fieldDef.relationName === relationName)
    ) {
      return fieldDef;
    }
  }
  return null;
};

const buildHaving = (op: ArrayOperator, count: number): Record<string, unknown> => {
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
