import type { SourceOption } from '../fieldMap/types';
import { fieldOf, own } from '../own';
import { readOwnPath } from '../scope';
import { inverseRelation } from '../toPrisma/relationUtils';
import { allOf, visitCondition } from '../traverse';
import type { Condition, Row } from '../types';
import { prefixConditionFields } from './narrowRule.ts';
import { type Policy, relationHops, resolvePolicy, resolveVisit } from './policy.ts';
import type { ProjectedVisit } from './projectPaths.ts';
import { projectPaths } from './projectPaths.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * Fold the traversal guards one dotted path picks up: every traversed model's
 * effective narrowing `where` (tenancy/soft-delete) — declared relation nodes AND
 * mapDefaults, composed across all layers via `resolveVisit` — re-rooted onto the
 * sourced model, the same hop-where fold `narrowRule` performs for rule paths. The
 * compile always joins every hop the path names, so every hop must carry its guard
 * whether or not the narrowing declares it.
 *
 * `strict` (a materialization path — a groupBy axis or a dotted label; its value
 * names which): an unresolvable hop is fail-closed — throw.
 * Lenient (`null`, where-clause field paths): stop at the first non-relation segment
 * (a plain column, or a Json column with a sub-path tail) — no join past it exists.
 * `seen` dedups hops shared across paths: one guard fold per traversed node.
 */
const foldPathGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  dotted: string,
  strict: 'groupBy' | 'label' | null,
  seen: Set<string>,
  out: Condition[],
): void => {
  const segments = dotted.split('.');
  // The last segment is the column; guards live on the traversed models.
  const { hops } = relationHops(
    policy.lens.maps,
    { mapName, modelName, relPath: baseRelPath },
    dotted,
  );
  const crossed = hops.filter((_, i) => i < segments.length - 1);
  if (strict && crossed.length < segments.length - 1) {
    const hop = segments[crossed.length];
    const on = crossed.at(-1)?.model ?? modelName;
    throw new Error(
      `${strict} '${dotted}': hop '${hop}' is not a resolvable relation on '${on}' — cannot guard its join`,
    );
  }
  for (const hop of crossed) {
    const hopKey = hop.relPath.join('.');
    if (seen.has(hopKey)) continue;
    seen.add(hopKey);
    const effect = resolveVisit(policy, hop.map, hop.model, hop.relPath);
    // A to-many hop has no single row to AND its grant against: fail closed, as narrowRule does.
    if (hop.isList && effect.whereClauses.length)
      throw new Error(
        `source path '${dotted}': cannot enforce the grant on to-many relation '${hop.prefix}' in a dotted path`,
      );
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, hop.prefix));
  }
};

/** Every dotted `field` a condition references. Relation nodes contribute their own
 * anchor `field`; their nested conditions are element-relative and compile inside the
 * relation filter, not as new joins from this model, so descent stops there. */
const collectFieldPaths = (condition: Condition): string[] => {
  const out: string[] = [];
  visitCondition(condition, (node) => {
    if (typeof node.field === 'string') out.push(node.field);
    return false;
  });
  return out;
};

/**
 * The composed traversal guards for one source: guards for every groupBy axis and
 * for a dotted label path (both strict — they name joins the select ships), and for
 * every relation path its `where` clauses reference (lenient) — the where ships
 * those joins just as surely as the group select does. Hops are folded once each
 * across all paths, so a label sharing a prefix with an axis costs no extra guard.
 */
const traversalGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  axes: readonly string[],
  whereClauses: readonly Condition[],
  label?: string,
): Condition[] => {
  const out: Condition[] = [];
  const seen = new Set<string>();
  for (const axis of axes)
    foldPathGuards(policy, mapName, modelName, baseRelPath, axis, 'groupBy', seen, out);
  if (label?.includes('.'))
    foldPathGuards(policy, mapName, modelName, baseRelPath, label, 'label', seen, out);
  for (const clause of whereClauses) {
    for (const path of collectFieldPaths(clause)) {
      if (path.includes('.'))
        foldPathGuards(policy, mapName, modelName, baseRelPath, path, null, seen, out);
    }
  }
  return out;
};

/** Walk a dotted to-one path through nested row objects; undefined when unreachable.
 * Serves both materialization paths a source declares: a groupBy axis and a dotted label. */
export const groupAtPath = (row: Row, path: string): string | undefined => {
  const value = readOwnPath(row, path);
  return value == null || typeof value === 'object' ? undefined : String(value);
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
const accumulateOption = (
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

/** One fetched row's options: each non-null scalar value of `field` (one per element of a
 *  scalar list), carrying the row's label and groups. */
export const accumulateRow = (
  byKey: Map<string, SourceOption>,
  row: Row,
  field: string,
  label: unknown,
  groups: string[] | undefined,
): void => {
  const raw = readOwnPath(row, field);
  const rowLabel = label == null ? undefined : String(label);
  for (const value of Array.isArray(raw) ? raw : [raw]) {
    if (value == null || typeof value === 'object') continue;
    accumulateOption(byKey, String(value), rowLabel, groups);
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

/** One sourced field to materialize: where it sits, its label and axes, and its eligibility —
 *  its source where(s), the guards of every relation they or the label / axes cross, and, for a
 *  value-gated field, the values the lens allows. */
export type SourcePlan = {
  path: string;
  visit: ProjectedVisit;
  field: string;
  from?: 'mapDefaults';
  label?: string;
  groupBy?: string[];
  eligibility: Condition[];
};

/**
 * The grants of every visit above a source's own, as conditions on the source's rows: each
 * ancestor's `where` carried down through the inverse of the hop below it — a to-one inverse by
 * prefixing its fields, a to-many one through `any`. An option list never offers what the rows
 * under the grant don't hold, so a grant no inverse can carry (none declared, a bridge, a path
 * ref) offers nothing.
 */
const ancestorGrants = (policy: Policy, relPath: readonly string[]): Condition[] => {
  if (relPath.length === 0) return [];
  const root = { mapName: policy.lens.mapName, modelName: policy.lens.model, relPath: [] };
  const { hops, end } = relationHops(policy.lens.maps, root, relPath.join('.'));
  if (!end) return [false];
  const visits = [root, ...hops.map((hop) => ({ mapName: hop.map, modelName: hop.model }))];
  let carried: Condition | null = null;
  for (let level = 0; level < relPath.length; level++) {
    const at = visits[level];
    const declared = resolveVisit(
      policy,
      at.mapName,
      at.modelName,
      relPath.slice(0, level),
    ).whereClauses;
    const grants = carried === null ? declared : [...declared, carried];
    if (grants.length === 0) {
      carried = null;
      continue;
    }
    const map = own(policy.lens.maps, at.mapName);
    const entry = map && fieldOf(map, at.modelName, relPath[level]);
    const inverse =
      map && entry && entry.kind === 'object' && visits[level + 1].mapName === at.mapName
        ? inverseRelation(map, at.modelName, relPath[level], entry)
        : null;
    if (!inverse) return [false];
    const here = allOf(grants);
    try {
      carried = inverse.entry.isList
        ? ({ field: inverse.field, arrayOperator: 'any', condition: here } as Condition)
        : allOf([
            { field: inverse.field, operator: 'exists' } as Condition,
            prefixConditionFields(here, inverse.field),
          ]);
    } catch {
      return [false];
    }
  }
  return carried === null ? [] : [carried];
};

/** Every sourced field the lens projects, planned once for both materializers. A path source
 *  carries the grants above it; one that offers its model's own source (`from: 'mapDefaults'`)
 *  reads that model as the lens narrows it — nothing carried from the path above by the layer
 *  that points or any after it; the layers before it still carry theirs. */
export const sourcePlans = (lensOrNarrowing: Lens | LensNarrowing): SourcePlan[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  return Object.entries(projectPaths(lensOrNarrowing)).flatMap(([path, visit]) =>
    Object.entries(visit.sources).map(([field, sourceClauses]) => {
      const label = own(visit.sourceLabels, field);
      const groupBy = own(visit.sourceGroupBys, field);
      const fromModel = Object.hasOwn(visit.sourceFrom, field);
      const relPath = path.split('.').slice(1);
      // Relations below the path keep every layer's narrowing, a pointer's included.
      const guards = traversalGuards(
        policy,
        visit.mapName,
        visit.model,
        relPath,
        groupBy ?? [],
        sourceClauses,
        label,
      );
      const allowed = own(visit.fields, field)?.values;
      // A pointer drops what the path above carries only from the layer that points on: the
      // layers before it still carry, so a child's pointer can only narrow what it was given.
      const pointsFrom = fromModel
        ? resolveVisit(policy, visit.mapName, visit.model, relPath).sourcesFromMapDefaults.get(
            field,
          )
        : undefined;
      const above = ancestorGrants(
        pointsFrom === undefined
          ? policy
          : { lens: policy.lens, chain: policy.chain.slice(0, pointsFrom) },
        relPath,
      );
      return {
        path,
        visit,
        field,
        ...(fromModel && { from: 'mapDefaults' as const }),
        ...(label !== undefined && { label }),
        ...(groupBy !== undefined && { groupBy }),
        eligibility: [
          ...above,
          ...sourceClauses,
          ...guards,
          ...(allowed ? [{ field, operator: 'in', value: [...allowed] } as Condition] : []),
        ],
      };
    }),
  );
};
