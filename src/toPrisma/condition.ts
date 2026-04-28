import type { Condition } from '../types';
import { buildAggregateRule, setConditionBuilderForAggregate } from './aggregate';
import { buildArrayRule, setConditionBuilderForArray } from './array';
import { buildDateRule } from './date';
import { buildFieldRule } from './field';
import { buildAll, buildAny, buildIfThenElse, setConditionBuilder } from './logical';
import type { BuildOptions, PrismaBuildState, PrismaWhere } from './types';

export const buildCondition = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (typeof condition === 'boolean') {
    if (condition) return {};
    throw new Error(
      `Boolean 'false' has no direct Prisma WHERE equivalent. toPrisma is designed for structured Rule conditions.`,
    );
  }

  if ('all' in condition) return buildAll(condition, options, state);
  if ('any' in condition) return buildAny(condition, options, state);
  if ('if' in condition) return buildIfThenElse(condition, options, state);
  if ('arrayOperator' in condition) return buildArrayRule(condition, options, state);
  if ('dateOperator' in condition) return buildDateRule(condition, options);
  if ('aggregate' in condition) return buildAggregateRule(condition, options, state);
  if ('field' in condition) return buildFieldRule(condition, options);

  throw new Error('Unknown condition type');
};

// Wire up circular dependencies
setConditionBuilder(buildCondition);
setConditionBuilderForArray(buildCondition);
setConditionBuilderForAggregate(buildCondition);
