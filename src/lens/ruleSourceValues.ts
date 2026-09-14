import type { Condition, RuleValue } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { ruleLeafValues } from './ruleLeafValues.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * The values one rule compares at one declared source — keyed the way `projectByPath`
 * keys a source (`path` + `field`), so the caller can join it back to the source's
 * model without spelling a path of its own. A `mapDefaults`-declared source resolves
 * wherever its model appears, so `path` may name a relation chain the narrowing never
 * spelled under `root.relations`; the dotted format is the same.
 */
export type RuleSourceValues = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  /** Every literal a leaf at this source named; list operators flattened, deduped by content. */
  values: RuleValue[];
  /**
   * The set of values cannot be enumerated from literals: a leaf took its value from
   * `path` / `bind`, used an operator that describes values without naming them
   * (substring, pattern, range, date window), or used an operator the catalog does not
   * know. A caller deciding anything from `values` must fail closed.
   */
  dynamic: boolean;
};

/**
 * Which values a rule names at each source the lens declares — the lens owns the
 * vocabulary, so it answers questions about it; callers never spell a path. A leaf reaches a
 * source by its absolute path through the lens: nested (`{ field: 'orders', arrayOperator,
 * condition: { field: 'sku' } }`) and dotted (`{ field: 'orders.sku' }`) spellings are one path,
 * resolved by `walkLensPath` — visibility, `mapDefaults`, and the Json boundary all apply, so a
 * source declared in `mapDefaults` answers wherever its model appears. Quantifier-blind on
 * purpose — a `none` relation names its value as much as an `any` one, `notIn` as much as `in` —
 * but shape-aware via the operator catalog: only literal-naming shapes contribute `values`;
 * substring / pattern / range / window operators, and operators the catalog does not know, mark
 * the source `dynamic` instead of inventing values. A relation node's own comparison (an
 * aggregate's threshold, an array `count`) belongs to the node, not to a source. Paths invisible
 * under the lens, unmapped segments, and sub-paths beneath a Json column are silent.
 */
export const ruleSourceValues = (
  lensOrNarrowing: Lens | LensNarrowing,
  rule: Condition,
): RuleSourceValues[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  return ruleLeafValues(policy, rule, (_leaf, resolved) =>
    resolved && resolved.terminalEffect.sources.has(resolved.terminalFieldName) ? {} : undefined,
  );
};
