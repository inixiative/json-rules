import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import type { SourceOption } from '../fieldMap/types';
import { hitsBridge } from '../fieldMap/walk';
import { fieldOf, own } from '../own';
import { readOwnPath } from '../scope';
import { inverseRelation } from '../toPrisma/relationUtils';
import { allOf } from '../traverse';
import type { Condition, Row } from '../types';
import { narrowAt, prefixConditionFields } from './narrowRule.ts';
import { LensRefusal, type Policy, relationHops, resolvePolicy, resolveVisit } from './policy.ts';
import { prismaRefusal } from './prismaRefusal.ts';
import type { PathProjection, ProjectedVisit } from './projectPaths.ts';
import { projectPathsWith } from './projectPaths.ts';
import { readPaths } from './readPaths.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * Fold the traversal guards a materialization path — a groupBy axis or a dotted label (`kind`
 * names which) — picks up: every traversed model's effective narrowing `where` (tenancy/soft-
 * delete) — declared relation nodes AND mapDefaults, composed across all layers via
 * `resolveVisit` — re-rooted onto the sourced model, the same hop-where fold `narrowRule`
 * performs for rule paths. The compile always joins every hop the path names, so every hop must
 * carry its guard whether or not the narrowing declares it; an unresolvable hop, or a to-many one
 * carrying a grant, is refused. `seen` dedups hops shared across paths: one guard fold per
 * traversed node.
 */
const foldPathGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  dotted: string,
  kind: 'groupBy' | 'label',
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
  if (crossed.length < segments.length - 1) {
    const hop = segments[crossed.length];
    const on = crossed.at(-1)?.model ?? modelName;
    throw new LensRefusal(
      `${kind} '${dotted}': hop '${hop}' is not a resolvable relation on '${on}' — cannot guard its join`,
      'invalid_source',
    );
  }
  for (const hop of crossed) {
    const hopKey = hop.relPath.join('.');
    if (seen.has(hopKey)) continue;
    seen.add(hopKey);
    const effect = resolveVisit(policy, hop.map, hop.model, hop.relPath);
    // A to-many hop has no single row to AND its grant against: fail closed, as narrowRule does.
    if (hop.isList && effect.whereClauses.length)
      throw new LensRefusal(
        `${kind} '${dotted}': cannot enforce the grant on to-many relation '${hop.prefix}' in a dotted path`,
        'unsupported_grant',
      );
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, hop.prefix));
  }
};

/** The composed traversal guards for one source's materialization paths: every groupBy axis and a
 *  dotted label — they name joins the select ships. Hops are folded once each across the paths,
 *  so a label sharing a prefix with an axis costs no extra guard. */
const traversalGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  axes: readonly string[],
  label?: string,
): Condition[] => {
  const out: Condition[] = [];
  const seen = new Set<string>();
  for (const axis of axes)
    foldPathGuards(policy, mapName, modelName, baseRelPath, axis, 'groupBy', seen, out);
  if (label?.includes('.'))
    foldPathGuards(policy, mapName, modelName, baseRelPath, label, 'label', seen, out);
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

/** Merge one occurrence into the accumulator; the least non-null label wins, so every rail —
 *  whatever order its rows come in — labels a value alike. */
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
  } else if (label !== undefined && (existing.label === undefined || label < existing.label)) {
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
    // Two options with one label order by value, so no rail's row order shows through.
    return (
      (a.label ?? a.value).localeCompare(b.label ?? b.value, 'en', { numeric: true }) ||
      a.value.localeCompare(b.value, 'en', { numeric: true })
    );
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
  /** What a row of the source's model must meet to offer its value: the visit's own grants and
   *  the eligibility, the path above carried down — what the option query compiles. */
  where: Condition;
  /** The same at the visit itself, for a row reached down the path: a fetched tree supplies the
   *  path and the grants above, so this leaves them out — what materializeSources checks. */
  rowWhere: Condition;
  /** The first path the source reads across a bridge (its where, label or an axis), if any: no
   *  database holds both sides, so only rows holding them both can answer it. */
  bridged?: string;
};

/**
 * The grants of every visit above a source's own, as conditions on the source's rows: each
 * ancestor's `where` carried down through the inverse of the hop below it — a to-one inverse by
 * prefixing its fields, a to-many one through `any`. A grant no inverse can carry is refused; past
 * a bridge the source is routed to caller rows (`bridged`), save a pointer with nothing to carry.
 * `linked`: the rows must also be reached down the path — the inverse carried
 * where no grant sits too — as a path source's are; a pointer's rows needn't be. A relation whose
 * map declares no inverse links nothing where no grant sits: the query offers the rows the grants
 * admit, reached or not.
 */
const ancestorGrants = (
  policy: Policy,
  relPath: readonly string[],
  carriedTo: Map<string, Condition | null>,
  linked: boolean,
): Condition[] | { bridged: string } => {
  if (relPath.length === 0) return [];
  const root = { mapName: policy.lens.mapName, modelName: policy.lens.model, relPath: [] };
  const { hops, end } = relationHops(policy.lens.maps, root, relPath.join('.'));
  if (!end)
    throw new LensRefusal(
      `source at '${relPath.join('.')}': its path doesn't resolve on the field maps`,
      'not_in_lens',
    );
  const visits = [root, ...hops.map((hop) => ({ mapName: hop.map, modelName: hop.model }))];
  // What the levels above carry is the same for every source below them: start below the deepest
  // level already carried.
  let from = relPath.length;
  while (from > 0 && !carriedTo.has(relPath.slice(0, from).join('.'))) from--;
  let carried = from > 0 ? (carriedTo.get(relPath.slice(0, from).join('.')) ?? null) : null;
  for (let level = from; level < relPath.length; level++) {
    const done = (value: Condition | null): void => {
      carried = value;
      carriedTo.set(relPath.slice(0, level + 1).join('.'), value);
    };
    const at = visits[level];
    const declared = resolveVisit(
      policy,
      at.mapName,
      at.modelName,
      relPath.slice(0, level),
    ).whereClauses;
    const grants = carried === null ? declared : [...declared, carried];
    if (grants.length === 0 && !linked) {
      done(null);
      continue;
    }
    const map = own(policy.lens.maps, at.mapName);
    const entry = map && fieldOf(map, at.modelName, relPath[level]);
    // Past a bridge no database holds both sides: the link and the grants can't be carried, and
    // the source is materialized from rows holding both — save a pointer with nothing to carry.
    if (!entry || entry.kind === 'bridge' || visits[level + 1].mapName !== at.mapName) {
      if (grants.length === 0 && !linked) {
        done(null);
        continue;
      }
      return { bridged: relPath.slice(0, level + 1).join('.') };
    }
    const inverse = map ? inverseRelation(map, at.modelName, relPath[level], entry) : null;
    // A map that declares no inverse links nothing (see the doc above); a grant it can't carry is
    // refused, never an empty list.
    if (!inverse && grants.length === 0) {
      done(null);
      continue;
    }
    if (!inverse)
      throw new LensRefusal(
        `source at '${relPath.join('.')}': '${relPath[level]}' on ${at.modelName} declares no inverse, so the grants above can't be carried down to it`,
        'unsupported_grant',
      );
    const here = allOf(grants);
    try {
      const present = { field: inverse.field, operator: 'exists' } as Condition;
      done(
        inverse.entry.isList
          ? ({ field: inverse.field, arrayOperator: 'any', condition: here } as Condition)
          : grants.length
            ? allOf([present, prefixConditionFields(here, inverse.field)])
            : present,
      );
    } catch (error) {
      // A link or grant the path can't carry is refused, never an empty list.
      if (!(error instanceof LensRefusal)) throw error;
      throw new LensRefusal(
        `source at '${relPath.join('.')}': the grants above can't be carried down to it — ${error.message}`,
        error.code,
      );
    }
  }
  return carried === null ? [] : [carried];
};

/** Every sourced field the lens projects, planned once for both materializers. Each source where
 *  is narrowed as a rule is under the whole lens — every relation it crosses carries its grants,
 *  inside an array condition too — so an option never comes through a row the lens hides. A path
 *  source carries the grants above it; one that offers its model's own source (`from:
 *  'mapDefaults'`) reads that model as the lens narrows it — nothing carried from the path above
 *  by the layer that points; every other layer still carries its own. */
export const sourcePlans = (lensOrNarrowing: Lens | LensNarrowing): SourcePlan[] =>
  sourcePlansWith(resolvePolicy(lensOrNarrowing));

export const sourcePlansWith = (
  policy: Policy,
  projection: PathProjection = projectPathsWith(policy),
): SourcePlan[] => {
  // What the grants above carry down each path, per layer a pointer drops (or none).
  const carried = new Map<LensNarrowing | undefined, Map<string, Condition | null>>();
  const carriedFor = (layer: LensNarrowing | undefined): Map<string, Condition | null> => {
    const kept = carried.get(layer) ?? new Map<string, Condition | null>();
    carried.set(layer, kept);
    return kept;
  };
  return Object.entries(projection).flatMap(([path, visit]) =>
    Object.keys(visit.sources).map((field) => {
      const label = own(visit.sourceLabels, field);
      const groupBy = own(visit.sourceGroupBys, field);
      const fromModel = Object.hasOwn(visit.sourceFrom, field);
      const at = {
        mapName: visit.mapName,
        modelName: visit.model,
        relPath: path.split('.').slice(1),
      };
      const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
      const wheres = (effect.sourceWheres.get(field) ?? []).map((where) =>
        narrowAt(where, policy, at),
      );
      // Relations below the path keep every layer's narrowing, a pointer's included.
      const guards = traversalGuards(
        policy,
        at.mapName,
        at.modelName,
        at.relPath,
        groupBy ?? [],
        label,
      );
      const allowed = own(visit.fields, field)?.values;
      // A pointer drops what the path above carries in the layer that points, and only there:
      // every layer before or after it still carries, and later layers' grants still read through
      // the pointing layer (the chain keeps its indices), so no layer's narrowing is lost.
      const pointsFrom = fromModel ? effect.sourcesFromMapDefaults.get(field) : undefined;
      const skip = pointsFrom === undefined ? undefined : policy.chain[pointsFrom];
      const carried = ancestorGrants(
        skip === undefined ? policy : { ...policy, skipGrantsOf: skip },
        at.relPath,
        carriedFor(skip),
        skip === undefined && !fromModel,
      );
      const above = Array.isArray(carried) ? carried : [];
      const pathBridged = Array.isArray(carried) ? undefined : carried.bridged;
      const eligibility = [
        ...above,
        ...wheres,
        ...guards,
        ...(allowed ? [{ field, operator: 'in', value: [...allowed] } as Condition] : []),
      ];
      const where = allOf([...visit.whereClauses, ...eligibility]);
      const rowWhere = allOf([
        ...visit.whereClauses,
        ...wheres,
        ...guards,
        ...(allowed ? [{ field, operator: 'in', value: [...allowed] } as Condition] : []),
      ]);
      // Only a lens with bridges can read across one.
      const fieldMap = policy.lens.bridges?.length
        ? resolveFieldMap(policy.lens, at.mapName, 'toPrisma')
        : undefined;
      const bridged =
        pathBridged ??
        (fieldMap
          ? [...readPaths(where), ...(label === undefined ? [] : [label]), ...(groupBy ?? [])].find(
              (read) => hitsBridge(read, fieldMap, at.modelName),
            )
          : undefined);
      // The option query compiles it: a shape it has no form for is refused here, so validation
      // and every materializer refuse it alike.
      const refusal = prismaRefusal(
        policy,
        [...visit.whereClauses, ...eligibility],
        at,
        `source '${field}' at '${path}'`,
        true,
      );
      if (refusal) throw refusal;
      return {
        path,
        visit,
        field,
        ...(fromModel && { from: 'mapDefaults' as const }),
        ...(label !== undefined && { label }),
        ...(groupBy !== undefined && { groupBy }),
        where,
        rowWhere,
        ...(bridged !== undefined && { bridged }),
      };
    }),
  );
};
