import type { All, Any, IfThenElse, Condition } from '../types';
import type { BuilderState } from './types';

// Forward declaration - will be provided by condition.ts
type BuildConditionFn = (condition: Condition, state: BuilderState) => string;
let buildCondition: BuildConditionFn;

export const setConditionBuilder = (fn: BuildConditionFn) => {
  buildCondition = fn;
};

export const buildAll = (all: All, state: BuilderState): string => {
  if (all.all.length === 0) return 'TRUE';
  const clauses = all.all.map((c) => buildCondition(c, state));
  return `(${clauses.join(' AND ')})`;
};

export const buildAny = (any: Any, state: BuilderState): string => {
  if (any.any.length === 0) return 'FALSE';
  const clauses = any.any.map((c) => buildCondition(c, state));
  return `(${clauses.join(' OR ')})`;
};

export const buildIfThenElse = (cond: IfThenElse, state: BuilderState): string => {
  const ifClause = buildCondition(cond.if, state);
  const thenClause = buildCondition(cond.then, state);
  const elseClause = cond.else ? buildCondition(cond.else, state) : 'TRUE';

  // if → then is equivalent to: NOT(if) OR then
  // With else: (NOT(if) OR then) AND (if OR else)
  if (cond.else) {
    return `((NOT(${ifClause}) OR ${thenClause}) AND (${ifClause} OR ${elseClause}))`;
  }
  return `(NOT(${ifClause}) OR ${thenClause})`;
};
