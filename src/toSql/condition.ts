import { rejectScopedField } from '../scope';
import { hitsBridge } from '../toPrisma/mapWalk';
import type { Condition } from '../types';
import { buildAggregateRule } from './aggregate';
import { buildArrayRule } from './array';
import { buildDateRule } from './date';
import { buildFieldRule } from './field';
import { buildAll, buildAny, buildIfThenElse } from './logical';
import { setConditionBuilder } from './recurse';
import type { BuilderState } from './types';

export const buildCondition = (condition: Condition, state: BuilderState): string => {
  if (typeof condition === 'boolean') {
    return condition ? 'TRUE' : 'FALSE';
  }
  rejectScopedField(condition, 'toSql');

  if (
    'field' in condition &&
    typeof condition.field === 'string' &&
    state.map &&
    state.currentModel &&
    hitsBridge(condition.field, state.map, state.currentModel)
  ) {
    return 'TRUE';
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

setConditionBuilder(buildCondition);
