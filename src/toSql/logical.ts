import type { All, Any, Condition, IfThenElse } from '../types';
import type { BuilderState, FieldMap } from './types';

// gloss
type BuildConditionFn = (condition: Condition, state: BuilderState) => string;
let buildCondition: BuildConditionFn;

export const setConditionBuilder = (fn: BuildConditionFn) => {
  buildCondition = fn;
};

// gloss
const pathHitsBridge = (field: string, map: FieldMap, model: string): boolean => {
  const parts = field.split('.');
  let cur = model;
  for (let i = 0; i < parts.length; i++) {
    const me = map.models[cur];
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

// gloss
const resolveRelationTargetModel = (
  field: string,
  map: FieldMap,
  rootModel: string,
): string | null => {
  const parts = field.split('.');
  let cur = rootModel;
  for (const part of parts) {
    const entry = map.models[cur]?.fields[part];
    if (!entry || entry.kind !== 'object') return null;
    cur = entry.type;
  }
  return cur;
};

// gloss
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

    if ('condition' in cond && cond.condition !== undefined) {
      const target = resolveRelationTargetModel(cond.field, state.map, state.currentModel);
      if (target) {
        if (conditionTouchesBridge(cond.condition, { ...state, currentModel: target })) return true;
      }
    }
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

// gloss
export const buildIfThenElse = (cond: IfThenElse, state: BuilderState): string => {
  if (
    conditionTouchesBridge(cond.if, state) ||
    conditionTouchesBridge(cond.then, state) ||
    (cond.else !== undefined && conditionTouchesBridge(cond.else, state))
  ) {
    return 'TRUE';
  }

  const ifClause = buildCondition(cond.if, state);
  const thenClause = buildCondition(cond.then, state);

  if (cond.else !== undefined) {
    const elseClause = buildCondition(cond.else, state);
    return `((NOT(${ifClause}) OR ${thenClause}) AND (${ifClause} OR ${elseClause}))`;
  }
  return `(NOT(${ifClause}) OR ${thenClause})`;
};
