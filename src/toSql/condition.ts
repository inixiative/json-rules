import { ambiguousCondition } from '../errors';
import { rejectScopedField } from '../scope';
import { hitsBridge, refuseRelationsValue } from '../toPrisma/mapWalk';
import { conditionShape } from '../traverse';
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

  const shape = conditionShape(condition as Record<string, unknown>);
  if (shape === 'field' || shape === 'date')
    refuseRelationsValue((condition as { field: string }).field, state.map, state.currentModel);
  const node = condition as never;
  switch (shape) {
    case 'all':
      return buildAll(node, state);
    case 'any':
      return buildAny(node, state);
    case 'if':
      return buildIfThenElse(node, state);
    case 'array':
      return buildArrayRule(node, state);
    case 'aggregate':
      return buildAggregateRule(node, state);
    case 'date':
      return buildDateRule(node, state);
    case 'field':
      return buildFieldRule(node, state);
    default:
      throw ambiguousCondition();
  }
};

setConditionBuilder(buildCondition);
