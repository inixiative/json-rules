import { orderPair } from '../number';
import { Operator } from '../operator';
import { fieldOf } from '../own';
import type { AggregateRule, Condition } from '../types';
import { hasWindow } from '../window';
import { walkFieldPath } from './mapWalk';
import { relationKeys } from './relationUtils';
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
import { readSource } from './valueSource';

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
  if (hasWindow(rule))
    throw new Error(
      'Windowing (orderBy/take/skip) is not supported by toPrisma(); evaluate with check().',
    );

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

  return buildAggregateStep(
    rule,
    options as BuildOptions & { map: FieldMap; model: string },
    state,
  );
};

/**
 * An aggregate's field path: to-one relations, then the to-many relation it aggregates over
 * (e.g. 'department.employees' on User: User → Department, then Department.employees).
 */
const aggregatePath = (field: string, map: FieldMap, rootModel: string) => {
  const walk = walkFieldPath(field, map, rootModel);
  const segments = field.split('.');
  if (walk.kind !== 'direct' || walk.entry.kind !== 'object') {
    const seg = segments[walk.hops.length];
    const on = walk.hops.at(-1)?.entry.type ?? rootModel;
    throw new Error(
      `Field '${seg}' is not a relation in model '${on}'. Prisma aggregate rules only support relation fields.`,
    );
  }
  const toMany = walk.hops.find((hop) => hop.entry.isList);
  if (toMany)
    throw new Error(
      `Intermediate field '${toMany.field}' in path '${field}' is a list relation. ` +
        `Only the final segment can be a list relation for aggregate rules.`,
    );
  if (!walk.entry.isList)
    throw new Error(`Field '${walk.column}' is not a list relation in model '${walk.model}'.`);
  return {
    intermediateRelations: walk.hops.map((hop) => ({
      fieldName: hop.field,
      entry: hop.entry,
      onModel: hop.from,
    })),
    terminalModel: walk.model,
    terminalEntry: walk.entry,
  };
};

const buildAggregateStep = (
  rule: AggregateRule,
  options: BuildOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  const { map, model: rootModel } = options;

  const { intermediateRelations, terminalModel, terminalEntry } = aggregatePath(
    rule.field,
    map,
    rootModel,
  );

  const targetModel = terminalEntry.type;
  const itemField = rule.aggregate.field ?? '';

  const targetFieldEntry = fieldOf(map, targetModel, itemField);
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

  const keys = relationKeys(map, terminalModel, terminalEntry);
  if (!keys) {
    throw new Error(
      `Cannot determine FK relationship between '${terminalModel}' and '${targetModel}'. ` +
        `Ensure the FieldMap contains both sides of the relation.`,
    );
  }
  if (keys.length > 1) throw new Error(`Aggregate rules do not support composite FK relations.`);
  const { here: pkOnTerminal, there: fkOnTarget } = keys[0];

  // Build inner WHERE from condition (if present)
  const innerWhere = rule.condition
    ? buildConditionRef(rule.condition, { ...options, model: targetModel }, state)
    : {};

  // Prisma 6.x having format: field first, then aggregate operator nested inside.
  const aggKey = rule.aggregate.mode === 'sum' ? '_sum' : '_avg';
  const having = { [itemField]: { [aggKey]: buildPrismaFilter(rule, options) } };

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

const buildPrismaFilter = (rule: AggregateRule, options: BuildOptions): Record<string, unknown> => {
  const value = readSource(rule, options);
  if (value === null || value === undefined)
    throw new Error('A Prisma aggregate compares against a number; its value source read nothing');
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
      const [min, max] = orderPair(value as number[]);
      return { gte: min, lte: max };
    }
    case Operator.notBetween:
      throw new Error(`Operator 'notBetween' is not supported for Prisma aggregate rules.`);
    default:
      throw new Error(`Operator '${rule.operator}' is not supported for Prisma aggregate rules.`);
  }
};
