import type { All, Any, IfThenElse, Condition } from '../types';
import type { PrismaWhere, BuildOptions, PrismaBuildState } from './types';

// Forward declaration - provided by condition.ts to avoid circular import
type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;
let buildCondition: BuildConditionFn;

export const setConditionBuilder = (fn: BuildConditionFn) => {
  buildCondition = fn;
};

export const buildAll = (all: All, options?: BuildOptions, state?: PrismaBuildState): PrismaWhere => {
  if (all.all.length === 0) return {};
  return { AND: all.all.map((c) => buildCondition(c, options, state)) };
};

export const buildAny = (any: Any, options?: BuildOptions, state?: PrismaBuildState): PrismaWhere => {
  if (any.any.length === 0) return { AND: [{ id: null }, { id: { not: null } }] };
  return { OR: any.any.map((c) => buildCondition(c, options, state)) };
};

export const buildIfThenElse = (
  cond: IfThenElse,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  // if → then is equivalent to: NOT(if) OR then
  // With else: (NOT(if) OR then) AND (if OR else)
  //
  // The `if` condition must be built twice as independent objects
  // (SQL reuses the same string; Prisma WHERE objects cannot be shared references)
  const notIf = { NOT: buildCondition(cond.if, options, state) };
  const thenClause = buildCondition(cond.then, options, state);

  if (cond.else) {
    const ifClause = buildCondition(cond.if, options, state);
    const elseClause = buildCondition(cond.else, options, state);
    return {
      AND: [
        { OR: [notIf, thenClause] },
        { OR: [ifClause, elseClause] },
      ],
    };
  }

  return { OR: [notIf, thenClause] };
};
