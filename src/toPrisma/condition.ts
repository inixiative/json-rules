import { rejectScopedField } from '../scope';
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

  if ('all' in condition) return buildAll(condition, options, state);
  if ('any' in condition) return buildAny(condition, options, state);
  if ('if' in condition) return buildIfThenElse(condition, options, state);
  if ('arrayOperator' in condition) return buildArrayRule(condition, options, state);
  if (('dateOperator' in condition || 'operator' in condition) && !('aggregate' in condition))
    refuseRelationsValue(condition.field, options?.map as FieldMap | undefined, options?.model);
  if ('dateOperator' in condition) return buildDateRule(condition, options);
  if ('aggregate' in condition) return buildAggregateRule(condition, options, state);
  if ('field' in condition) return buildFieldRule(condition, options);

  throw new Error('Unknown condition type');
};

setConditionBuilder(buildCondition);
