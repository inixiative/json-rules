import { Operator } from '../operator';
import type { AggregateRule, Condition } from '../types';
import { findReverseRelation } from './relationUtils';
import type {
  BuildOptions,
  FieldMap,
  FieldMapEntry,
  GroupByStep,
  PrismaBuildState,
  PrismaWhere,
  StepRef,
} from './types';
import { buildNestedFilter } from './utils';

// Forward declaration - provided by condition.ts to avoid circular import
type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;
let buildConditionRef: BuildConditionFn;

export const setConditionBuilderForAggregate = (fn: BuildConditionFn) => {
  buildConditionRef = fn;
};

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

/**
 * Walk a dot-notation field path through the FieldMap to find the terminal list relation.
 *
 * Returns the segments traversed, the final list relation entry, and the model it lives on.
 * E.g. for 'department.employees' on User:
 *   - segments: ['department', 'employees']
 *   - intermediate: User → Department (singular)
 *   - terminal: Department.employees → Employee (list)
 */
const walkAggregateFieldPath = (
  field: string,
  map: FieldMap,
  rootModel: string,
): {
  segments: string[];
  intermediateRelations: { fieldName: string; entry: FieldMapEntry; onModel: string }[];
  terminalModel: string;
  terminalEntry: FieldMapEntry;
} => {
  const segments = field.split('.');
  const intermediateRelations: { fieldName: string; entry: FieldMapEntry; onModel: string }[] = [];
  let currentModel = rootModel;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const fieldEntry = map[currentModel]?.fields[seg];
    if (!fieldEntry || fieldEntry.kind !== 'object') {
      throw new Error(
        `Field '${seg}' is not a relation in model '${currentModel}'. ` +
          `Prisma aggregate rules only support relation fields.`,
      );
    }

    if (i === segments.length - 1) {
      // Terminal segment — must be a list relation
      if (!fieldEntry.isList) {
        throw new Error(`Field '${seg}' is not a list relation in model '${currentModel}'.`);
      }
      return {
        segments,
        intermediateRelations,
        terminalModel: currentModel,
        terminalEntry: fieldEntry,
      };
    }

    // Intermediate segment — must be a singular relation
    if (fieldEntry.isList) {
      throw new Error(
        `Intermediate field '${seg}' in path '${field}' is a list relation. ` +
          `Only the final segment can be a list relation for aggregate rules.`,
      );
    }

    intermediateRelations.push({ fieldName: seg, entry: fieldEntry, onModel: currentModel });
    currentModel = fieldEntry.type;
  }

  throw new Error(`Field path '${field}' did not terminate at a list relation.`);
};

const buildAggregateStep = (
  rule: AggregateRule,
  options: BuildOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  const { map, model: rootModel } = options;

  const { intermediateRelations, terminalModel, terminalEntry } = walkAggregateFieldPath(
    rule.field,
    map,
    rootModel,
  );

  const targetModel = terminalEntry.type;
  const itemField = rule.aggregate.field ?? '';

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
  let pkOnTerminal: string;

  if (terminalEntry.fromFields && terminalEntry.fromFields.length > 0) {
    if (terminalEntry.fromFields.length > 1) {
      throw new Error(`Aggregate rules do not support composite FK relations.`);
    }
    fkOnTarget = terminalEntry.toFields?.[0] ?? 'id';
    pkOnTerminal = terminalEntry.fromFields[0];
  } else {
    const reverseRelation = findReverseRelation(
      map,
      targetModel,
      terminalModel,
      terminalEntry.relationName,
    );
    if (!reverseRelation) {
      throw new Error(
        `Cannot determine FK relationship between '${terminalModel}' and '${targetModel}'. ` +
          `Ensure the FieldMap contains both sides of the relation.`,
      );
    }
    if ((reverseRelation.fromFields?.length ?? 0) > 1) {
      throw new Error(`Aggregate rules do not support composite FK relations.`);
    }
    fkOnTarget = reverseRelation.fromFields?.[0] ?? '';
    pkOnTerminal = reverseRelation.toFields?.[0] ?? '';
  }

  // Build inner WHERE from condition (if present)
  const innerWhere = rule.condition
    ? buildConditionRef(rule.condition, { ...options, model: targetModel }, state)
    : {};

  // Prisma 6.x having format: field first, then aggregate operator nested inside.
  const aggKey = rule.aggregate.mode === 'sum' ? '_sum' : '_avg';
  const having = { [itemField]: { [aggKey]: buildPrismaFilter(rule) } };

  const step: GroupByStep = {
    operation: 'groupBy',
    model: targetModel,
    args: { by: [fkOnTarget], where: innerWhere, having },
    extract: fkOnTarget,
  };

  const stepIndex = state.steps.length;
  state.steps.push(step);

  const stepRef: StepRef = { __step: stepIndex };

  // If there are intermediate relations, nest the filter through them
  if (intermediateRelations.length > 0) {
    // The step ref gives us IDs of the model that owns the terminal list relation.
    // We need to filter back through intermediate relations to the root model.
    const leafFilter = { [pkOnTerminal]: { in: stepRef } };
    const relationPath = intermediateRelations.map((r) => r.fieldName).join('.');
    return buildNestedFilter(relationPath, leafFilter);
  }

  return { [pkOnTerminal]: { in: stepRef } };
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
