import type { Condition } from '../types';
import { buildAggregateRule } from './aggregate';
import { buildArrayRule } from './array';
import { buildDateRule } from './date';
import { buildFieldRule } from './field';
import { buildAll, buildAny, buildIfThenElse, setConditionBuilder } from './logical';
import type { BuilderState } from './types';

export const buildCondition = (condition: Condition, state: BuilderState): string => {
  if (typeof condition === 'boolean') {
    return condition ? 'TRUE' : 'FALSE';
  }

  if ('all' in condition) return buildAll(condition, state);
  if ('any' in condition) return buildAny(condition, state);
  if ('if' in condition) return buildIfThenElse(condition, state);
  if ('arrayOperator' in condition) return buildArrayRule(condition, state);
  if ('dateOperator' in condition) return buildDateRule(condition, state);
  if ('aggregate' in condition) return buildAggregateRule(condition, state);
  if ('field' in condition) return buildFieldRule(condition, state);

  throw new Error('Unknown condition type');
};

// Wire up circular dependency
setConditionBuilder(buildCondition);
