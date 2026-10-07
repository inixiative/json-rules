import { conditionRequired, countRequired } from '../errors';
import type { FieldMap } from '../fieldMap/types';
import { ArrayOperator } from '../operator';
import { comparatorOf } from '../operatorCatalog';
import type { ArrayRule } from '../types';
import { holdsForEmpty } from './array';
import { groupMembership, groupPath } from './groupStep';
import { matchAll } from './logical';
import { buildCondition } from './recurse';
import type { PrismaBuildState, PrismaWhere, ToPrismaOptions } from './types';

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
  options: ToPrismaOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  if (!rule.field) throw new Error('toPrisma: count-based ArrayRule requires a field path');
  const path = groupPath(rule.field, options.map, options.model, 'Count operators');

  // Same contract as check(): a count operator without a condition or count is an
  // authoring error, not a default.
  if (rule.condition === undefined) throw conditionRequired(rule.arrayOperator);
  if (rule.count === undefined) throw countRequired(rule.arrayOperator);
  const count = rule.count;
  if (rule.arrayOperator === ArrayOperator.atLeast && count === 0) return matchAll();

  const where = buildCondition(rule.condition, { ...options, model: path.target }, state);
  // The zero-inclusive operators hold for a parent with no matching children, which no group
  // carries: atMost N = NOT(atLeast N+1), exactly 0 = NOT(atLeast 1).
  const complement = holdsForEmpty(rule);
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
  const bound = comparatorOf(op, 'array');
  if (!bound) throw new Error(`'${op}' does not count`);
  return { [field]: { _count: { [bound]: count } } };
};
