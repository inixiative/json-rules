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
 * Under AND the fold drops it (no-op); under OR the fold absorbs the whole
 * disjunction into `{}` (over-fetch, safe). But in `if/then`, the implication is
 * encoded as `NOT(if) OR then`, and NOT of the sentinel is where the two meanings of
 * `{}` part ways: NOT(true) is match-nothing, while NOT(unknown) must stay unknown.
 * Folding would under-fetch, so a bridge anywhere in the implication over-fetches
 * the whole expression instead.
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

/**
 * The two boolean constants and how Prisma reads them.
 *
 * `{}` is match-all only where Prisma treats an empty filter as "no constraint": the top
 * level, an AND arm, a relation filter (`some: {}`). Inside an OR Prisma DROPS it — `OR: [x, {}]`
 * is just `x` — and `NOT: {}` is not the negation of true. `{ OR: [] }` is the documented
 * match-nothing and composes correctly everywhere.
 *
 * So the logical builders never nest a constant under OR or NOT; they fold it instead:
 * a `true` arm absorbs an OR, a `false` arm absorbs an AND, either drops out of the other,
 * and NOT of a constant is the other constant. The fold runs on compiled output, so it also
 * covers constants that arrive indirectly — `all: []`, `any: []`, `atLeast 0`, and the bridge
 * over-fetch sentinel (a bridge under `any` now over-fetches the disjunction instead of being
 * dropped by Prisma and under-fetching).
 *
 * Every arm is compiled exactly once, in order, BEFORE folding. Count operators push a
 * groupBy step into `state` as they compile, so an arm that then folds away leaves its step
 * behind — harmless (an unreferenced step is executed and ignored) and necessary: step refs
 * are positional, so nothing may be rebuilt or renumbered.
 */
const matchAll = (): PrismaWhere => ({});
const matchNothing = (): PrismaWhere => ({ OR: [] });
const isMatchAll = (where: PrismaWhere): boolean => Object.keys(where).length === 0;
const isMatchNothing = (where: PrismaWhere): boolean => {
  const keys = Object.keys(where);
  return keys.length === 1 && keys[0] === 'OR' && Array.isArray(where.OR) && where.OR.length === 0;
};

const andWhere = (arms: PrismaWhere[]): PrismaWhere => {
  if (arms.some(isMatchNothing)) return matchNothing();
  const rest = arms.filter((arm) => !isMatchAll(arm));
  return rest.length === 0 ? matchAll() : { AND: rest };
};

const orWhere = (arms: PrismaWhere[]): PrismaWhere => {
  if (arms.some(isMatchAll)) return matchAll();
  const rest = arms.filter((arm) => !isMatchNothing(arm));
  return rest.length === 0 ? matchNothing() : { OR: rest };
};

const notWhere = (where: PrismaWhere): PrismaWhere => {
  if (isMatchAll(where)) return matchNothing();
  if (isMatchNothing(where)) return matchAll();
  return { NOT: where };
};

export const buildAll = (all: All, options?: BuildOptions, state?: PrismaBuildState): PrismaWhere =>
  andWhere(all.all.map((c) => buildCondition(c, options, state)));

export const buildAny = (any: Any, options?: BuildOptions, state?: PrismaBuildState): PrismaWhere =>
  orWhere(any.any.map((c) => buildCondition(c, options, state)));

export const buildIfThenElse = (
  cond: IfThenElse,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  // if → then is equivalent to: NOT(if) OR then
  // With else: (NOT(if) OR then) AND (if OR else)
  //
  // When any sub-clause hits a bridge, the precise compilation breaks. The sentinel `{}`
  // means "unknown here" for a bridge, and neither Prisma nor the constant fold can carry
  // that through a negation: Prisma ignores `NOT: {}` (measured: it matches everything),
  // and the fold would read it as NOT(true) = match-nothing. Either way an `if` bridge
  // collapses the implication to `then` alone, and a bridge in `then`/`else` with the
  // other branch present drops that branch. Over-fetch the whole expression and let the
  // caller's check() filter against hydrated cross-source data.
  if (
    conditionTouchesBridge(cond.if, options) ||
    conditionTouchesBridge(cond.then, options) ||
    (cond.else !== undefined && conditionTouchesBridge(cond.else, options))
  ) {
    return {};
  }

  // Each clause is built exactly once: a count-based array operator in `if` pushes a
  // GroupByStep as it compiles, and the same clause is reused in both conjuncts below.
  // Boolean branches (`then: true`, `else: false`, …) are compiled like any other
  // condition and folded by orWhere/andWhere/notWhere so no constant lands under OR/NOT.
  const ifClause = buildCondition(cond.if, options, state);
  const thenClause = buildCondition(cond.then, options, state);
  const implication = orWhere([notWhere(ifClause), thenClause]);

  // !== undefined so `else: false` (deny branch) is emitted rather than skipped.
  if (cond.else !== undefined) {
    const elseClause = buildCondition(cond.else, options, state);
    return andWhere([implication, orWhere([ifClause, elseClause])]);
  }

  return implication;
};
