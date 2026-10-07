import { negate } from '../negate';
import type { All, Any, Condition, IfThenElse } from '../types';
import { conditionTouchesBridge } from './mapWalk';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';
import { settleLeaf } from './valueSource';

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
export const matchNothing = (): PrismaWhere => ({ OR: [] });
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

/** OR of arms: match-all absorbs, match-nothing drops, one arm stands alone. */
export const orWhere = (arms: PrismaWhere[]): PrismaWhere => {
  if (arms.some(isMatchAll)) return matchAll();
  const rest = arms.filter((arm) => !isMatchNothing(arm));
  if (rest.length === 0) return matchNothing();
  return rest.length === 1 ? rest[0] : { OR: rest };
};

/** A leaf filter's complement. A bridged leaf compiles to the over-fetch sentinel `{}` —
 *  unknown, not true — and its complement stays unknown; Prisma reads `NOT: {}` as match-all too. */
export const notLeaf = (where: PrismaWhere): PrismaWhere =>
  isMatchAll(where) ? where : { NOT: where };

export const buildAll = (all: All, options?: BuildOptions, state?: PrismaBuildState): PrismaWhere =>
  andWhere(all.all.map((c) => buildCondition(c, options, state)));

export const buildAny = (any: Any, options?: BuildOptions, state?: PrismaBuildState): PrismaWhere =>
  orWhere(any.any.map((c) => buildCondition(c, options, state)));

export const buildIfThenElse = (
  cond: IfThenElse,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  // if → then is: (complement of if) OR then
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
    conditionTouchesBridge(cond as Condition, options?.map as FieldMap | undefined, options?.model)
  ) {
    return {};
  }

  // Each clause is built exactly once: a count-based array operator in `if` pushes a
  // GroupByStep as it compiles, and the same clause is reused in both conjuncts below.
  // Boolean branches (`then: true`, `else: false`, …) are compiled like any other
  // condition and folded by orWhere/andWhere/notWhere so no constant lands under OR/NOT.
  // Prisma's NOT drops a row whose `if` is NULL (a NULL field) that check() reads as false, so
  // the implication compiles the complement of `if` instead of negating it.
  const notIf = buildCondition(negate(cond.if, settleLeaf(options)), options, state);
  const thenClause = buildCondition(cond.then, options, state);
  const implication = orWhere([notIf, thenClause]);

  // !== undefined so `else: false` (deny branch) is emitted rather than skipped.
  if (cond.else !== undefined) {
    const ifClause = buildCondition(cond.if, options, state);
    const elseClause = buildCondition(cond.else, options, state);
    return andWhere([implication, orWhere([ifClause, elseClause])]);
  }

  return implication;
};
