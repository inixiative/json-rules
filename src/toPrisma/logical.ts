import type { All, Any, Condition, IfThenElse } from '../types';
import { walkFieldPath } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';

// gloss
type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;
let buildCondition: BuildConditionFn;

export const setConditionBuilder = (fn: BuildConditionFn) => {
  buildCondition = fn;
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
const conditionTouchesBridge = (cond: Condition, options?: BuildOptions): boolean => {
  if (typeof cond === 'boolean') return false;
  if (!options?.map || !options?.model) return false;

  if ('all' in cond) return cond.all.some((c) => conditionTouchesBridge(c, options));
  if ('any' in cond) return cond.any.some((c) => conditionTouchesBridge(c, options));
  if ('if' in cond) {
    return (
      conditionTouchesBridge(cond.if, options) ||
      conditionTouchesBridge(cond.then, options) ||
      (cond.else !== undefined && conditionTouchesBridge(cond.else, options))
    );
  }

  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const result = walkFieldPath(cond.field, options.map as FieldMap, options.model);
    if (result.kind === 'bridge') return true;

    if ('condition' in cond && cond.condition !== undefined) {
      const target = resolveRelationTargetModel(cond.field, options.map as FieldMap, options.model);
      if (target) {
        if (conditionTouchesBridge(cond.condition, { ...options, model: target })) return true;
      }
    }
  }
  return false;
};

export const buildAll = (
  all: All,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (all.all.length === 0) return {};
  return { AND: all.all.map((c) => buildCondition(c, options, state)) };
};

export const buildAny = (
  any: Any,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (any.any.length === 0) return { AND: [{ id: null }, { id: { not: null } }] };
  return { OR: any.any.map((c) => buildCondition(c, options, state)) };
};

// gloss
export const buildIfThenElse = (
  cond: IfThenElse,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (
    conditionTouchesBridge(cond.if, options) ||
    conditionTouchesBridge(cond.then, options) ||
    (cond.else !== undefined && conditionTouchesBridge(cond.else, options))
  ) {
    return {};
  }

  const ifClause = buildCondition(cond.if, options, state);
  const notIf = { NOT: ifClause };
  const thenClause =
    cond.then === false ? MATCH_NOTHING : buildCondition(cond.then, options, state);

  if (cond.else !== undefined) {
    const elseClause =
      cond.else === false ? MATCH_NOTHING : buildCondition(cond.else, options, state);
    return {
      AND: [{ OR: [notIf, thenClause] }, { OR: [ifClause, elseClause] }],
    };
  }

  return { OR: [notIf, thenClause] };
};

// gloss
const MATCH_NOTHING: PrismaWhere = { AND: [{ id: null }, { id: { not: null } }] };
