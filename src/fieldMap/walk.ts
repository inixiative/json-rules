import { fieldOf, modelOf, own } from '../own';
import { someCondition } from '../traverse';
import type { Condition } from '../types';
import { parseEndpointKey } from './endpointKey.ts';
import { isJsonEntry } from './entry';
import type { FieldMap, FieldMapEntry } from './types';

/** A model a walk stands on, and the relation path that reached it. */
export type MapVisit = { mapName: string; modelName: string; relPath: readonly string[] };

/** One segment of a walk: the entry it names at `at` (undefined when undeclared), and the model a
 *  relation entry leads to. */
export type MapStep = {
  index: number;
  field: string;
  at: MapVisit;
  entry: FieldMapEntry | undefined;
  next: { mapName: string; modelName: string } | null;
};

/** The model a relation entry leads to, in this map or across a bridge; null for a column. */
export const relationTargetOf = (
  entry: FieldMapEntry,
  currentMap: string,
): { mapName: string; modelName: string } | null => {
  if (entry.kind === 'object') return { mapName: currentMap, modelName: entry.type };
  if (entry.kind === 'bridge') return parseEndpointKey(entry.type, currentMap);
  return null;
};

/**
 * The one walk of a dotted path through field maps: each segment read at the model the previous
 * relation reached. It ends after an undeclared segment or a column; callers stop earlier where
 * their semantics do (a bridge, a hidden field, a Json boundary).
 */
export function* walkMaps(
  maps: Record<string, FieldMap>,
  from: MapVisit,
  path: string,
): Generator<MapStep> {
  const parts = path.split('.');
  let at: MapVisit = from;
  for (let index = 0; index < parts.length; index++) {
    const field = parts[index];
    const entry = fieldOf(own(maps, at.mapName), at.modelName, field);
    const next = entry ? relationTargetOf(entry, at.mapName) : null;
    yield { index, field, at, entry, next };
    if (!next) return;
    at = { ...next, relPath: [...at.relPath, field] };
  }
}

/** A relation the walk crossed on the way to the terminal segment. */
export type MapHop = { field: string; prefix: string; entry: FieldMapEntry; from: string };

/**
 * A dot-notation field path walked through a FieldMap — the one walk both compilers use:
 * - `direct`      the path ends on a declared field (`entry`), a column of `model` or a relation
 * - `json-path`   it reaches a Json column (`column`) and continues as a JSON path
 * - `bridge`      it crosses a bridge to another source
 * - `past-scalar` it continues past a non-Json column, which has no sub-fields
 * - `fallback`    a segment isn't declared; the compilers read the path as written
 * `hops` are the relations crossed before the terminal segment, outermost first.
 */
export type MapWalkResult =
  | { kind: 'direct'; hops: MapHop[]; entry: FieldMapEntry; model: string; column: string }
  | {
      kind: 'json-path';
      hops: MapHop[];
      entry: FieldMapEntry;
      model: string;
      column: string;
      stopIndex: number;
      jsonPath: string[];
    }
  | { kind: 'bridge'; hops: MapHop[] }
  | { kind: 'past-scalar'; hops: MapHop[]; column: string }
  | { kind: 'fallback'; hops: MapHop[] };

export const walkFieldPath = (field: string, map: FieldMap, rootModel: string): MapWalkResult => {
  const parts = field.split('.');
  const hops: MapHop[] = [];
  const from = { mapName: '', modelName: rootModel, relPath: [] };
  for (const { index: i, field: column, at, entry } of walkMaps({ '': map }, from, field)) {
    const model = at.modelName;
    if (!entry) return { kind: 'fallback', hops };
    if (entry.kind === 'bridge') return { kind: 'bridge', hops };
    const last = i === parts.length - 1;
    if (entry.kind === 'object') {
      if (!modelOf(map, entry.type)) return { kind: 'fallback', hops };
      if (last) return { kind: 'direct', hops, entry, model, column };
      hops.push({ field: column, prefix: parts.slice(0, i + 1).join('.'), entry, from: model });
      continue;
    }
    if (last) return { kind: 'direct', hops, entry, model, column };
    if (isJsonEntry(entry))
      return {
        kind: 'json-path',
        hops,
        entry,
        model,
        column,
        stopIndex: i + 1,
        jsonPath: parts.slice(i + 1),
      };
    return { kind: 'past-scalar', hops, column };
  }
  return { kind: 'fallback', hops };
};

/** A field's walk, when a map and model are given. */
export const walkWith = (
  field: string,
  map: FieldMap | undefined,
  model: string | undefined,
): MapWalkResult | undefined => (map && model ? walkFieldPath(field, map, model) : undefined);

/** The declared entry a field path ends on, when the map declares it. */
export const fieldEntry = (
  field: string,
  map: FieldMap | undefined,
  model: string | undefined,
): FieldMapEntry | undefined => {
  const walk = walkWith(field, map, model);
  return walk?.kind === 'direct' ? walk.entry : undefined;
};

/**
 * The dotted prefixes of `field` that end on an OPTIONAL to-one relation, outermost first —
 * every hop at which the path can be absent as a whole. Same licensing authority as
 * `isRequired` on a column.
 */
export const optionalToOneHops = (field: string, map: FieldMap, rootModel: string): string[] =>
  walkFieldPath(field, map, rootModel)
    .hops.filter((hop) => !hop.entry.isList && hop.entry.isRequired === false)
    .map((hop) => hop.prefix);

/** The model a path of relations leads to; null when a segment isn't a declared relation. */
export const relationTarget = (field: string, map: FieldMap, model: string): string | null => {
  const walk = walkFieldPath(field, map, model);
  return walk.kind === 'direct' && walk.entry.kind === 'object' ? walk.entry.type : null;
};

/** Whether a field path crosses a bridge. */
export const hitsBridge = (field: string, map: FieldMap, model: string): boolean =>
  walkFieldPath(field, map, model).kind === 'bridge';

/**
 * Whether a bridge appears anywhere in a condition, a relation node's `condition` / `filter`
 * read at its target model. Bridge predicates compile to an over-fetch sentinel (`TRUE` / `{}`),
 * which is safe under AND / OR but not under the `NOT(if) OR then` of an implication — so an
 * implication that touches one over-fetches whole.
 */
export const conditionTouchesBridge = (
  condition: Condition,
  map: FieldMap | undefined,
  model: string | undefined,
): boolean =>
  !!map &&
  !!model &&
  someCondition<string>(
    condition,
    (node, at) =>
      typeof node.field === 'string' && node.field !== '' && hitsBridge(node.field, map, at),
    (node, at) =>
      (typeof node.field === 'string' ? relationTarget(node.field, map, at) : at) ?? false,
    model,
  );
