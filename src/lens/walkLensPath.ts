import {
  type LensPathResolution,
  lensRootScope,
  resolvePolicy,
  resolvePolicyPath,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type { LensPathHop, LensPathResolution } from './policy.ts';

/**
 * Resolve one dotted path through a lens, hop by hop, verifying as it walks: every hop is checked
 * against the narrowing at that visit, so a field the narrowing hides is `hidden`, a field the
 * model lacks is `missing`, and a segment past a scalar is `pastScalar`. This is the walk
 * `validateRuleInLens` gates a rule's field with, exposed for consumers that resolve paths of their
 * own (template tokens, loop bindings, presence guards).
 */
export const walkLensPath = (
  lensOrNarrowing: Lens | LensNarrowing,
  path: string,
): LensPathResolution => {
  const policy = resolvePolicy(lensOrNarrowing);
  return resolvePolicyPath(policy, lensRootScope(policy), path).resolution;
};
