import type { SourceOption } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { prefixConditionFields } from './applyLens.ts';
import { type Policy, resolveVisit } from './policy.ts';
import { resolveRelationTarget } from './walk.ts';

type Row = Record<string, unknown>;

/**
 * Fold the traversal guards one dotted path picks up: every traversed model's
 * effective narrowing `where` (tenancy/soft-delete) — declared relation nodes AND
 * mapDefaults, composed across all layers via `resolveVisit` — re-rooted onto the
 * sourced model, the same hop-where fold `applyLens` performs for rule paths. The
 * compile always joins every hop the path names, so every hop must carry its guard
 * whether or not the narrowing declares it.
 *
 * `strict` (groupBy axes): an unresolvable hop is fail-closed — throw.
 * Lenient (where-clause field paths): stop at the first non-relation segment (a
 * plain column, or a Json column with a sub-path tail) — no join past it exists.
 * `seen` dedups hops shared across paths: one guard fold per traversed node.
 */
const foldPathGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  dotted: string,
  strict: boolean,
  seen: Set<string>,
  out: Condition[],
): void => {
  const segments = dotted.split('.');
  let curMap = mapName;
  let curModel = modelName;
  const relPath = [...baseRelPath];
  // The last segment is the column; guards live on the traversed models.
  for (let i = 0; i < segments.length - 1; i++) {
    const entry = policy.lens.maps[curMap]?.models[curModel]?.fields[segments[i]];
    const target = entry ? resolveRelationTarget(entry, curMap) : null;
    if (!target) {
      if (strict) {
        throw new Error(
          `groupBy '${dotted}': hop '${segments[i]}' is not a resolvable relation on '${curModel}' — cannot guard its join`,
        );
      }
      return; // plain column / Json sub-path — nothing joins past here
    }
    relPath.push(segments[i]);
    curMap = target.mapName;
    curModel = target.modelName;
    const hopKey = relPath.join('.');
    if (seen.has(hopKey)) continue;
    seen.add(hopKey);
    const effect = resolveVisit(policy, curMap, curModel, relPath);
    const prefix = segments.slice(0, i + 1).join('.');
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, prefix));
  }
};

/** Every dotted `field` a condition references (all/any/if recursion; array and
 * aggregate rules contribute their own anchor `field` — their nested conditions
 * are element-relative and compile inside the relation filter, not as new joins
 * from this model). */
const collectFieldPaths = (condition: Condition, out: string[] = []): string[] => {
  if (typeof condition !== 'object' || condition === null) return out;
  const c = condition as Record<string, unknown>;
  if (Array.isArray(c.all)) for (const child of c.all as Condition[]) collectFieldPaths(child, out);
  if (Array.isArray(c.any)) for (const child of c.any as Condition[]) collectFieldPaths(child, out);
  if (c.if !== undefined) {
    collectFieldPaths(c.if as Condition, out);
    collectFieldPaths(c.then as Condition, out);
    if (c.else !== undefined) collectFieldPaths(c.else as Condition, out);
  }
  if (typeof c.field === 'string') out.push(c.field);
  return out;
};

/**
 * The composed traversal guards for one source: guards for every groupBy axis
 * (strict) and for every relation path its `where` clauses reference (lenient) —
 * the where ships those joins just as surely as the group select does. Hops are
 * folded once each across all paths.
 */
export const traversalGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  axes: readonly string[],
  whereClauses: readonly Condition[],
): Condition[] => {
  const out: Condition[] = [];
  const seen = new Set<string>();
  for (const axis of axes)
    foldPathGuards(policy, mapName, modelName, baseRelPath, axis, true, seen, out);
  for (const clause of whereClauses) {
    for (const path of collectFieldPaths(clause)) {
      if (path.includes('.'))
        foldPathGuards(policy, mapName, modelName, baseRelPath, path, false, seen, out);
    }
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

/** Resolve every axis for a row — all-or-nothing: any unreachable axis leaves the
 * option ungrouped. A partial key would make partition pins unpredictable. */
export const groupsAtPaths = (row: Row, paths: readonly string[]): string[] | undefined => {
  const out: string[] = [];
  for (const path of paths) {
    const value = groupAtPath(row, path);
    if (value === undefined) return undefined;
    out.push(value);
  }
  return out;
};

/** Dedup key — options are unique per (groups, value), not per value. */
export const optionKey = (groups: readonly string[] | undefined, value: string): string =>
  JSON.stringify([groups ?? null, value]);

/** Merge one occurrence into the accumulator; the first non-null label wins. */
export const accumulateOption = (
  byKey: Map<string, SourceOption>,
  value: string,
  label: string | undefined,
  groups: string[] | undefined,
): void => {
  const key = optionKey(groups, value);
  const existing = byKey.get(key);
  if (existing === undefined) {
    byKey.set(key, {
      value,
      ...(label !== undefined ? { label } : {}),
      ...(groups !== undefined ? { groups } : {}),
    });
  } else if (existing.label === undefined && label !== undefined) {
    byKey.set(key, { ...existing, label });
  }
};

// Fixed locale: host-locale sorting would make option order machine-dependent.
// Ungrouped options are their own leading tier — an empty-string DB label is a
// real group and must never interleave with "no group". Grouped options order by
// their axes lexicographically, then label/value.
export const sortOptions = (byKey: Map<string, SourceOption>): SourceOption[] =>
  [...byKey.values()].sort((a, b) => {
    const tier = (a.groups === undefined ? 0 : 1) - (b.groups === undefined ? 0 : 1);
    if (tier !== 0) return tier;
    const ga = a.groups ?? [];
    const gb = b.groups ?? [];
    for (let i = 0; i < Math.max(ga.length, gb.length); i++) {
      const cmp = (ga[i] ?? '').localeCompare(gb[i] ?? '', 'en', { numeric: true });
      if (cmp !== 0) return cmp;
    }
    return (a.label ?? a.value).localeCompare(b.label ?? b.value, 'en', { numeric: true });
  });
