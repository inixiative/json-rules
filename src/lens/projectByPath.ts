import type { FieldMapEntry, SourceOption } from '../toPrisma/types.ts';
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
  /** Per-field display-label column for a sourced field (from a SourceSpec's `label`). */
  sourceLabels: Record<string, string>;
  /** Per-field option-partition path for a sourced field (from a SourceSpec's `groupBy`). */
  sourceGroupBys: Record<string, string>;
};

export type PathProjection = Map<string, ProjectedVisit>;

/**
 * The materialized option set for one sourced field — the fetched companion to a
 * serializable lens. Its `options` are `{ value, label? }` pairs (the standard
 * `<select>` shape); it feeds both projections: `projectByPath` keys by
 * `path`+`field` (exact), `exposedSurface` by `mapName`+`model`+`field` (union).
 */
export type SourceValues = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  options: readonly SourceOption[];
};

export type ProjectOptions = { sourceValues?: readonly SourceValues[] };

export const projectByPath = (
  lensOrNarrowing: Lens | LensNarrowing,
  opts: ProjectOptions = {},
): PathProjection => {
  const policy = resolvePolicy(lensOrNarrowing);
  const out: PathProjection = new Map();

  const fetchedByPathField = new Map<string, readonly SourceOption[]>();
  for (const sv of opts.sourceValues ?? []) {
    fetchedByPathField.set(`${sv.path}|${sv.field}`, sv.options);
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
      const fetchedOptions = fetchedByPathField.get(`${dottedPath}|${fieldName}`);
      const enumValues = effect.enumValuesByField.get(fieldName);
      let projected = enumValues !== undefined ? { ...entry, values: enumValues } : entry;
      // A sourced field's fetched pairs win; otherwise a value-gated field surfaces
      // its resolved allowed-set as options, so every selectable field exposes `options`.
      const options = fetchedOptions ?? enumValues?.map((v) => ({ value: v, label: v }));
      if (options) projected = { ...projected, options };
      fields[fieldName] = projected;
    }

    const sources: Record<string, Condition[]> = {};
    for (const [fieldName, clauses] of effect.sources) {
      if (isFieldVisible(effect, fieldName)) sources[fieldName] = clauses;
    }

    const sourceLabels: Record<string, string> = {};
    for (const [fieldName, label] of effect.sourceLabels) {
      if (isFieldVisible(effect, fieldName)) sourceLabels[fieldName] = label;
    }

    const sourceGroupBys: Record<string, string> = {};
    for (const [fieldName, groupBy] of effect.sourceGroupBys) {
      if (isFieldVisible(effect, fieldName)) sourceGroupBys[fieldName] = groupBy;
    }

    out.set(dottedPath, {
      mapName,
      modelName,
      fields,
      whereClauses: effect.whereClauses,
      sources,
      sourceLabels,
      sourceGroupBys,
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
