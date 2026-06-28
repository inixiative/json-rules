import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { isFieldVisible, resolvePolicy, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

export type ProjectedVisit = {
  mapName: string;
  modelName: string;
  fields: Record<string, FieldMapEntry>;
  whereClauses: Condition[];
  /** Per-field source eligibility wheres, composed across layers (general + path). */
  sources: Record<string, Condition[]>;
};

export type PathProjection = Map<string, ProjectedVisit>;

/**
 * The materialized option set for one sourced field — the fetched companion to a
 * serializable lens. Shaped to be exactly what `sourceQueries()` emits plus the
 * fetched `values`, so it feeds both projections: `projectByPath` keys by
 * `path`+`field` (exact), `exposedSurface` by `mapName`+`model`+`field` (union).
 */
export type SourceValues = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  values: readonly string[];
};

export type ProjectOptions = { sourceValues?: readonly SourceValues[] };

export const projectByPath = (
  lensOrNarrowing: Lens | LensNarrowing,
  opts: ProjectOptions = {},
): PathProjection => {
  const policy = resolvePolicy(lensOrNarrowing);
  const out: PathProjection = new Map();

  const fetchedByPathField = new Map<string, readonly string[]>();
  for (const sv of opts.sourceValues ?? []) {
    fetchedByPathField.set(`${sv.path}|${sv.field}`, sv.values);
  }

  const visit = (
    mapName: string,
    modelName: string,
    relPath: string[],
    dottedPath: string,
  ): void => {
    if (out.has(dottedPath)) return;
    const model = policy.lens.maps[mapName]?.models[modelName];
    if (!model) return;

    const effect = resolveVisit(policy, mapName, modelName, relPath);

    const fields: Record<string, FieldMapEntry> = {};
    for (const [fieldName, entry] of Object.entries(model.fields)) {
      if (!isFieldVisible(effect, fieldName)) continue;
      const fetched = fetchedByPathField.get(`${dottedPath}|${fieldName}`);
      const values = fetched ?? effect.enumValuesByField.get(fieldName);
      fields[fieldName] = values !== undefined ? { ...entry, values } : entry;
    }

    const sources: Record<string, Condition[]> = {};
    for (const [fieldName, clauses] of effect.sources) {
      if (isFieldVisible(effect, fieldName)) sources[fieldName] = clauses;
    }

    out.set(dottedPath, {
      mapName,
      modelName,
      fields,
      whereClauses: effect.whereClauses,
      sources,
    });

    for (const relField of effect.relations.keys()) {
      const entry = model.fields[relField];
      if (!entry) continue;
      const target = resolveRelationTarget(entry, mapName);
      if (!target) continue;
      visit(target.mapName, target.modelName, [...relPath, relField], `${dottedPath}.${relField}`);
    }
  };

  visit(policy.lens.mapName, policy.lens.model, [], policy.lens.model);
  return out;
};
