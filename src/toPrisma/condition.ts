import { ambiguousCondition } from '../errors';
import { rejectScopedField } from '../scope';
import { conditionShape } from '../traverse';
import type { Condition } from '../types';
import { buildAggregateRule } from './aggregate';
import { buildArrayRule } from './array';
import { buildDateRule } from './date';
import { buildFieldRule } from './field';
import { buildAll, buildAny, buildIfThenElse, matchNothing } from './logical';
import { refuseRelationsValue } from './mapWalk';
import { setConditionBuilder } from './recurse';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';

export const buildCondition = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  // Prisma's empty OR matches nothing — `false` compiles, same as toSql's FALSE. `{}` is
  // match-all only at the top level and under AND; the logical builders fold both
  // constants so neither ever lands under OR or NOT (see logical.ts).
  if (typeof condition === 'boolean') {
    return condition ? {} : matchNothing();
  }
  rejectScopedField(condition, 'toPrisma');

  const shape = conditionShape(condition as Record<string, unknown>);
  if (shape === 'field' || shape === 'date')
    refuseRelationsValue(
      (condition as { field: string }).field,
      options?.map as FieldMap | undefined,
      options?.model,
    );
  const node = condition as never;
  switch (shape) {
    case 'all':
      return buildAll(node, options, state);
    case 'any':
      return buildAny(node, options, state);
    case 'if':
      return buildIfThenElse(node, options, state);
    case 'array':
      return buildArrayRule(node, options, state);
    case 'aggregate':
      return buildAggregateRule(node, options, state);
    case 'date':
      return buildDateRule(node, options);
    case 'field':
      return buildFieldRule(node, options);
    default:
      throw ambiguousCondition();
  }
};

setConditionBuilder(buildCondition);
