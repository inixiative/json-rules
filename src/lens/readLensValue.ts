import { type CheckOptions, check } from '../check';
import { isRelationEntry } from '../fieldMap/entry';
import { own } from '../own';
import { readOwnPath } from '../scope';
import type { Row } from '../types';
import { lensRootScope, resolvePolicy, resolvePolicyPath, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** A value read through a lens, or why the lens refuses the path. */
export type LensValue =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'hidden' | 'missing' | 'pastScalar' | 'relation' | 'list' };

/**
 * One value off a row, as the lens shows it: the path walked as `validateRuleInLens` walks a
 * field (a hidden, missing or past-scalar segment is refused), each related row checked against
 * its visit's grants, the row itself included (a row a grant hides, or a missing one, reads `null`), and only the row's own
 * properties read, into a Json column too. A path ending on a relation, or crossing a list, names
 * rows rather than a value and is refused. `options` is what each grant is checked with.
 */
export const readLensValue = (
  lensOrNarrowing: Lens | LensNarrowing,
  row: Row,
  path: string,
  options: CheckOptions = {},
): LensValue => {
  const policy = resolvePolicy(lensOrNarrowing);
  const { resolution } = resolvePolicyPath(policy, lensRootScope(policy), path);
  if (resolution.outcome !== 'resolved') return { ok: false, reason: resolution.outcome };
  const { hops, terminal, jsonSubPath } = resolution;
  if (isRelationEntry(terminal.entry)) return { ok: false, reason: 'relation' };
  if (hops.some((hop) => hop !== terminal && hop.entry.isList))
    return { ok: false, reason: 'list' };

  const admits = (visit: { mapName: string; model: string; relPath: string[] }, at: unknown) =>
    at !== null &&
    typeof at === 'object' &&
    resolveVisit(policy, visit.mapName, visit.model, visit.relPath).whereClauses.every(
      (where) => check(where, at as Row, options) === true,
    );

  let at: unknown = admits(hops[0], row) ? row : null;
  for (const [index, hop] of hops.entries()) {
    if (at === null || typeof at !== 'object') return { ok: true, value: null };
    const value = own(at as Row, hop.field);
    if (hop === terminal)
      return {
        ok: true,
        value: jsonSubPath.length ? readOwnPath(value, jsonSubPath.join('.')) : value,
      };
    at = admits(hops[index + 1], value) ? value : null;
  }
  return { ok: true, value: null };
};
