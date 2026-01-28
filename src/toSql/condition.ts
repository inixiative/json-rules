import type { Condition } from '../types';
import type { BuilderState } from './types';
import { buildFieldRule } from './field';
import { buildDateRule } from './date';
import { buildArrayRule } from './array';
import { buildAll, buildAny, buildIfThenElse, setConditionBuilder } from './logical';

export const buildCondition = (condition: Condition, state: BuilderState): string => {
  if (typeof condition === 'boolean') {
    return condition ? 'TRUE' : 'FALSE';
  }

  if ('all' in condition) return buildAll(condition, state);
  if ('any' in condition) return buildAny(condition, state);
  if ('if' in condition) return buildIfThenElse(condition, state);
  if ('arrayOperator' in condition) return buildArrayRule(condition, state);
  if ('dateOperator' in condition) return buildDateRule(condition, state);
  if ('field' in condition) return buildFieldRule(condition, state);

  throw new Error('Unknown condition type');
};

// Wire up circular dependency
setConditionBuilder(buildCondition);
