import type { SourceOption } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { prefixConditionFields } from './applyLens.ts';
import { type Policy, resolveVisit } from './policy.ts';
import { resolveRelationTarget } from './walk.ts';

type Row = Record<string, unknown>;

/**
 * The traversal guards a `groupBy` path picks up: every traversed model's effective
 * narrowing `where` (tenancy/soft-delete) — declared relation nodes AND mapDefaults,
 * composed across all layers via `resolveVisit` — re-rooted onto the sourced model,
 * the same hop-where fold `applyLens` performs for rule paths. The fold walks the
 * groupBy path itself: the compile always joins every hop, so every hop must carry
 * its guard whether or not the narrowing declares it. An unresolvable hop is
 * fail-closed — the join it implies could not be guarded.
 */
export const groupGuardClauses = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  groupBy: string,
): Condition[] => {
  const out: Condition[] = [];
  const segments = groupBy.split('.');
  let curMap = mapName;
  let curModel = modelName;
  const relPath = [...baseRelPath];
  // The last segment is the column; guards live on the traversed models.
  for (let i = 0; i < segments.length - 1; i++) {
    const entry = policy.lens.maps[curMap]?.models[curModel]?.fields[segments[i]];
    const target = entry ? resolveRelationTarget(entry, curMap) : null;
    if (!target) {
      throw new Error(
        `groupBy '${groupBy}': hop '${segments[i]}' is not a resolvable relation on '${curModel}' — cannot guard its join`,
      );
    }
    relPath.push(segments[i]);
    curMap = target.mapName;
    curModel = target.modelName;
    const effect = resolveVisit(policy, curMap, curModel, relPath);
    const prefix = segments.slice(0, i + 1).join('.');
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, prefix));
  }
  return out;
};

/** Walk a dotted to-one path through nested row objects; undefined when unreachable. */
export const groupAtPath = (row: Row, path: string): string | undefined => {
  let cur: unknown = row;
  for (const segment of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[segment];
  }
  return cur == null || typeof cur === 'object' ? undefined : String(cur);
};

/** Dedup key — options are unique per (group, value), not per value. */
export const optionKey = (group: string | undefined, value: string): string =>
  JSON.stringify([group ?? null, value]);

/** Merge one occurrence into the accumulator; the first non-null label wins. */
export const accumulateOption = (
  byKey: Map<string, SourceOption>,
  value: string,
  label: string | undefined,
  group: string | undefined,
): void => {
  const key = optionKey(group, value);
  const existing = byKey.get(key);
  if (existing === undefined) {
    byKey.set(key, {
      value,
      ...(label !== undefined ? { label } : {}),
      ...(group !== undefined ? { group } : {}),
    });
  } else if (existing.label === undefined && label !== undefined) {
    byKey.set(key, { ...existing, label });
  }
};

// Fixed locale: host-locale sorting would make option order machine-dependent.
// Ungrouped options are their own leading tier — an empty-string DB label is a
// real group and must never interleave with "no group".
export const sortOptions = (byKey: Map<string, SourceOption>): SourceOption[] =>
  [...byKey.values()].sort((a, b) => {
    const tier = (a.group === undefined ? 0 : 1) - (b.group === undefined ? 0 : 1);
    if (tier !== 0) return tier;
    const byGroup = (a.group ?? '').localeCompare(b.group ?? '', 'en', { numeric: true });
    if (byGroup !== 0) return byGroup;
    return (a.label ?? a.value).localeCompare(b.label ?? b.value, 'en', { numeric: true });
  });
