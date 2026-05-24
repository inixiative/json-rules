import type { All, Any, Condition, IfThenElse } from '../types';
import type { BuilderState, FieldMap } from './types';

// Forward declaration - will be provided by condition.ts
type BuildConditionFn = (condition: Condition, state: BuilderState) => string;
let buildCondition: BuildConditionFn;

export const setConditionBuilder = (fn: BuildConditionFn) => {
  buildCondition = fn;
};

/**
 * Walks a field path through the FieldMap; returns true if any segment hits a bridge.
 * Bridge predicates compile to 'TRUE' in toSql — fine as a no-op in AND, but inside
 * `NOT(...)` they corrupt the implication semantics.
 */
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

const conditionTouchesBridge = (cond: Condition, state: BuilderState): boolean => {
  if (typeof cond === 'boolean') return false;
  if (!state.map || !state.currentModel) return false;
  if ('all' in cond) return cond.all.some((c) => conditionTouchesBridge(c, state));
  if ('any' in cond) return cond.any.some((c) => conditionTouchesBridge(c, state));
  if ('if' in cond) {
    return (
      conditionTouchesBridge(cond.if, state) ||
      conditionTouchesBridge(cond.then, state) ||
      (cond.else !== undefined && conditionTouchesBridge(cond.else, state))
    );
  }
  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    if (pathHitsBridge(cond.field, state.map, state.currentModel)) return true;
  }
  return false;
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
  if (
    conditionTouchesBridge(cond.if, state) ||
    conditionTouchesBridge(cond.then, state) ||
    (cond.else !== undefined && conditionTouchesBridge(cond.else, state))
  ) {
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
