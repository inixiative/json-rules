import type { Condition } from '../types';
import { buildAggregateRule } from './aggregate';
import { buildArrayRule } from './array';
import { buildDateRule } from './date';
import { buildFieldRule } from './field';
import { buildAll, buildAny, buildIfThenElse, setConditionBuilder } from './logical';
import type { BuilderState, FieldMap } from './types';

const pathHitsBridge = (field: string, map: FieldMap, model: string): boolean => {
  const parts = field.split('.');
  let cur = model;
  for (let i = 0; i < parts.length; i++) {
    const me = map[cur];
    if (!me) return false;
    const fe = me.fields[parts[i]];
    if (!fe) return false;
    if (fe.kind === 'bridge') return true;
    if (fe.kind === 'object') {
      cur = fe.type;
      continue;
    }
    return false;
  }
  return false;
};

export const buildCondition = (condition: Condition, state: BuilderState): string => {
  if (typeof condition === 'boolean') {
    return condition ? 'TRUE' : 'FALSE';
  }

  if (
    'field' in condition &&
    typeof condition.field === 'string' &&
    state.map &&
    state.currentModel &&
    pathHitsBridge(condition.field, state.map, state.currentModel)
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

// Wire up circular dependency
setConditionBuilder(buildCondition);
