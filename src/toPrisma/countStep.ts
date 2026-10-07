import { ArrayOperator } from '../operator';
import type { ArrayRule, Condition } from '../types';
import { groupMembership, groupPath } from './groupStep';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';

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
  if (!rule.field) throw new Error('toPrisma: count-based ArrayRule requires a field path');
  const path = groupPath(rule.field, options.map, options.model, 'Count operators');

  // Same contract as check(): a count operator without a condition or count is an
  // authoring error, not a default.
  if (rule.condition === undefined)
    throw new Error(`${rule.arrayOperator} requires a condition to check against array elements`);
  if (rule.count === undefined) throw new Error(`${rule.arrayOperator} requires a count`);
  const count = rule.count;
  if (rule.arrayOperator === ArrayOperator.atLeast && count === 0) return {};

  const where = buildCondition(rule.condition, { ...options, model: path.target }, state);
  // The zero-inclusive operators hold for a parent with no matching children, which no group
  // carries: atMost N = NOT(atLeast N+1), exactly 0 = NOT(atLeast 1).
  const complement =
    rule.arrayOperator === ArrayOperator.atMost ||
    (rule.arrayOperator === ArrayOperator.exactly && count === 0);
  const having = complement
    ? countHaving(
        ArrayOperator.atLeast,
        rule.arrayOperator === ArrayOperator.atMost ? count + 1 : 1,
        path.targetKey,
      )
    : countHaving(rule.arrayOperator, count, path.targetKey);
  return groupMembership(state, path, where, having, complement);
};

// Prisma 6.x having format: field first, then _count nested inside.
// e.g. { fanUserUuid: { _count: { gte: 3 } } } — NOT { _count: { _all: { gte: 3 } } }
const countHaving = (op: ArrayOperator, count: number, field: string): Record<string, unknown> => {
  const bound = {
    [ArrayOperator.atLeast]: 'gte',
    [ArrayOperator.atMost]: 'lte',
    [ArrayOperator.exactly]: 'equals',
  }[op as 'atLeast' | 'atMost' | 'exactly'];
  if (!bound) throw new Error('unreachable');
  return { [field]: { _count: { [bound]: count } } };
};
