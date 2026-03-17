import { Operator } from '../operator';
import type { AggregateRule } from '../types';
import { findReverseRelation } from './relationUtils';
import type {
  BuildOptions,
  FieldMap,
  GroupByStep,
  PrismaBuildState,
  PrismaWhere,
  StepRef,
} from './types';

export const buildAggregateRule = (
  rule: AggregateRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (!options?.map || !options?.model || !state) {
    throw new Error(
      `Aggregate rules require a FieldMap and model to generate a Prisma plan. ` +
        `Pass { map, model } options to toPrisma().`,
    );
  }

  if (!rule.aggregate.field) {
    throw new Error(
      `Prisma aggregate rules require aggregate.field to specify the numeric field on the related model.`,
    );
  }

  if (rule.path) {
    throw new Error(`path is not supported for Prisma aggregate rules; use value instead.`);
  }

  return buildAggregateStep(
    rule,
    options as BuildOptions & { map: FieldMap; model: string },
    state,
  );
};

const buildAggregateStep = (
  rule: AggregateRule,
  options: BuildOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  const { map, model: currentModel } = options;

  const fieldEntry = map[currentModel]?.fields[rule.field];
  if (!fieldEntry || fieldEntry.kind !== 'object') {
    throw new Error(
      `Field '${rule.field}' is not a relation in model '${currentModel}'. ` +
        `Prisma aggregate rules only support relation fields.`,
    );
  }

  if (!fieldEntry.isList) {
    throw new Error(`Field '${rule.field}' is not a list relation in model '${currentModel}'.`);
  }

  const targetModel = fieldEntry.type;
  const itemField = rule.aggregate.field!;

  const targetFieldEntry = map[targetModel]?.fields[itemField];
  if (!targetFieldEntry) {
    throw new Error(`aggregate.field '${itemField}' does not exist on model '${targetModel}'.`);
  }
  if (targetFieldEntry.kind !== 'scalar') {
    throw new Error(
      `aggregate.field '${itemField}' on model '${targetModel}' must be a scalar field, got '${targetFieldEntry.kind}'.`,
    );
  }

  if (targetFieldEntry.type === 'Json') {
    throw new Error(
      `aggregate.field '${itemField}' on model '${targetModel}' is a Json field — aggregate rules require a numeric scalar.`,
    );
  }

  let fkOnTarget: string;
  let pkOnCurrent: string;

  if (fieldEntry.fromFields && fieldEntry.fromFields.length > 0) {
    if (fieldEntry.fromFields.length > 1) {
      throw new Error(`Aggregate rules do not support composite FK relations.`);
    }
    fkOnTarget = fieldEntry.toFields?.[0] ?? 'id';
    pkOnCurrent = fieldEntry.fromFields[0];
  } else {
    const reverseRelation = findReverseRelation(
      map,
      targetModel,
      currentModel,
      fieldEntry.relationName,
    );
    if (!reverseRelation) {
      throw new Error(
        `Cannot determine FK relationship between '${currentModel}' and '${targetModel}'. ` +
          `Ensure the FieldMap contains both sides of the relation.`,
      );
    }
    if ((reverseRelation.fromFields?.length ?? 0) > 1) {
      throw new Error(`Aggregate rules do not support composite FK relations.`);
    }
    fkOnTarget = reverseRelation.fromFields?.[0] ?? '';
    pkOnCurrent = reverseRelation.toFields?.[0] ?? '';
  }

  const aggKey = rule.aggregate.mode === 'sum' ? '_sum' : '_avg';
  const having = { [aggKey]: { [itemField]: buildPrismaFilter(rule) } };

  const step: GroupByStep = {
    operation: 'groupBy',
    model: targetModel,
    args: { by: [fkOnTarget], where: {}, having },
    extract: fkOnTarget,
  };

  const stepIndex = state.steps.length;
  state.steps.push(step);

  const stepRef: StepRef = { __step: stepIndex };
  return { [pkOnCurrent]: { in: stepRef } };
};

const buildPrismaFilter = (rule: AggregateRule): Record<string, unknown> => {
  const value = rule.value;
  switch (rule.operator) {
    case Operator.equals:
      return { equals: value };
    case Operator.notEquals:
      return { not: value };
    case Operator.lessThan:
      return { lt: value };
    case Operator.lessThanEquals:
      return { lte: value };
    case Operator.greaterThan:
      return { gt: value };
    case Operator.greaterThanEquals:
      return { gte: value };
    case Operator.between: {
      if (!Array.isArray(value) || value.length !== 2)
        throw new Error('between requires two values');
      const [a, b] = value as number[];
      const [min, max] = a <= b ? [a, b] : [b, a];
      return { gte: min, lte: max };
    }
    case Operator.notBetween:
      throw new Error(`Operator 'notBetween' is not supported for Prisma aggregate rules.`);
    default:
      throw new Error(`Operator '${rule.operator}' is not supported for Prisma aggregate rules.`);
  }
};
