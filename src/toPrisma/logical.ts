import type { All, Any, Condition, IfThenElse } from '../types';
import { walkFieldPath } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';

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

/**
 * Walks a relation field path and returns the target model name (for descending
 * into arrayRule/aggregate sub-conditions). Returns null if the path isn't a
 * chain of object relations (e.g. terminates in a scalar or hits a bridge).
 */
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

/**
 * Does this condition (recursively) hit a bridge field?
 *
 * Bridge predicates compile to `{}` in toPrisma (the over-fetch sentinel).
 * In direct AND/OR contexts that's a no-op or harmless over-fetch. But in
 * `if/then`, the implication is encoded as `NOT(if) OR then` — and Prisma
 * evaluates `NOT: {}` as match-nothing, which corrupts the implication.
 *
 * Recurses into arrayRule.condition and aggregate.condition, flipping the
 * model context to the relation target so nested fields resolve correctly.
 * A bridge anywhere in the if-clause subtree triggers over-fetch.
 */
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

  // Field-bearing leaves: arrayRule, aggregate, dateRule, field
  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const result = walkFieldPath(cond.field, options.map as FieldMap, options.model);
    if (result.kind === 'bridge') return true;

    // arrayRule/aggregate may carry a nested condition rooted on the relation target.
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

export const buildIfThenElse = (
  cond: IfThenElse,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  // if → then is equivalent to: NOT(if) OR then
  // With else: (NOT(if) OR then) AND (if OR else)
  //
  // When any sub-clause hits a bridge, the precise compilation breaks:
  //  - bridge in `if`: `NOT({})` becomes match-nothing in Prisma, corrupting the implication.
  //  - bridge in `then` with `else`: `OR[NOT(if), {}]` collapses to match-all, then
  //    AND-ed with `OR[if, else]` silently drops the `then` branch.
  //  - bridge in `else`: symmetric — drops the `else` branch.
  // Over-fetch the whole expression and let the caller's check() filter against
  // hydrated cross-source data.
  if (
    conditionTouchesBridge(cond.if, options) ||
    conditionTouchesBridge(cond.then, options) ||
    (cond.else !== undefined && conditionTouchesBridge(cond.else, options))
  ) {
    return {};
  }

  // Build the `if` clause once to avoid pushing duplicate GroupBySteps into state
  // when the `if` clause contains a count-based array operator (atLeast/atMost/exactly).
  const ifClause = buildCondition(cond.if, options, state);
  const notIf = { NOT: ifClause };
  // `false` as a then/else branch is a legal deny — buildCondition(false) would
  // throw, so emit the match-nothing pattern that buildAny uses for empty `any: []`.
  const thenClause =
    cond.then === false ? MATCH_NOTHING : buildCondition(cond.then, options, state);

  // !== undefined so `else: false` (deny branch) is emitted rather than skipped.
  if (cond.else !== undefined) {
    const elseClause =
      cond.else === false ? MATCH_NOTHING : buildCondition(cond.else, options, state);
    return {
      AND: [{ OR: [notIf, thenClause] }, { OR: [ifClause, elseClause] }],
    };
  }

  return { OR: [notIf, thenClause] };
};

// Prisma WHERE that matches no rows. Same self-contradiction shape used by buildAny's
// empty-array path; relies on the model having an `id` field (true for ~all Prisma models).
const MATCH_NOTHING: PrismaWhere = { AND: [{ id: null }, { id: { not: null } }] };
