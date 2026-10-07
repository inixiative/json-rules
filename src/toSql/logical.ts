import { conditionTouchesBridge } from '../toPrisma/mapWalk';
import type { All, Any, Condition, IfThenElse } from '../types';
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
  // When any sub-clause hits a bridge, the precise compilation breaks: bridge
  // predicates compile to 'TRUE', and NOT(TRUE) OR X = X collapses the implication
  // (or in the with-else form, silently drops the then/else branch). Over-fetch
  // the whole expression and let the caller's check() filter precisely.
  if (conditionTouchesBridge(cond as Condition, state.map, state.currentModel)) {
    return 'TRUE';
  }

  const ifClause = buildCondition(cond.if, state);
  const thenClause = buildCondition(cond.then, state);

  // if → then is equivalent to: NOT(if) OR then
  // With else: (NOT(if) OR then) AND (if OR else)
  if (cond.else !== undefined) {
    const elseClause = buildCondition(cond.else, state);
    return `((NOT(${ifClause}) OR ${thenClause}) AND (${ifClause} OR ${elseClause}))`;
  }
  return `(NOT(${ifClause}) OR ${thenClause})`;
};
