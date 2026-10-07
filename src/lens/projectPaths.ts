import type { FieldMapEntry, ModelEntry, SourceOption } from '../fieldMap/types';
import { relationTargetOf } from '../fieldMap/walk.ts';
import { own } from '../own';
import type { Condition } from '../types.ts';
import {
  isFieldVisible,
  resolvePolicy,
  resolveVisit,
  sourceReadsVisible,
  type VisitEffect,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type ProjectedVisit = {
  mapName: string;
  modelName: string;
  fields: Record<string, FieldMapEntry>;
  whereClauses: Condition[];
  /** Per-field source eligibility wheres, composed across layers (general + path). */
  sources: Record<string, Condition[]>;
  /** Per-field display label for a sourced field (from a SourceSpec's `label`): a sibling
   * column or a dotted to-one path. */
  sourceLabels: Record<string, string>;
  /** Per-field option-partition axes for a sourced field (from a SourceSpec's `groupBy`). */
  sourceGroupBys: Record<string, string[]>;
};

/** Each declared path's projected visit, keyed by dotted path from the lens model. */
export type PathProjection = Record<string, ProjectedVisit>;

/**
 * The materialized option set for one sourced field — the fetched companion to a
 * serializable lens. Its `options` are `{ value, label? }` pairs (the standard
 * `<select>` shape); it feeds both projections: `projectPaths` keys by
 * `path`+`field` (exact), `projectModels` by `mapName`+`model`+`field` (union).
 */
export type SourceValues = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  options: readonly SourceOption[];
};

export type ProjectLensOptions = { sourceValues?: readonly SourceValues[] };

/**
 * One visit's fields as the lens exposes them: the visible fields, a value-gated field carrying
 * its allowed `values`, fetched source `options` attached, and a grouped source's `groupBy` axes.
 * Both projections build their fields through it.
 */
export const projectFields = (
  effect: VisitEffect,
  model: ModelEntry,
  fetched: (field: string) => readonly SourceOption[] | undefined,
): Record<string, FieldMapEntry> => {
  const fields: Record<string, FieldMapEntry> = {};
  for (const [fieldName, entry] of Object.entries(model.fields)) {
    if (!isFieldVisible(effect, fieldName)) continue;
    const values = effect.enumValuesByField.get(fieldName);
    // Options never offer a value the lens disallows, whatever was fetched.
    const options = fetched(fieldName)?.filter(
      (o) => values === undefined || values.includes(o.value),
    );
    const groupBy = effect.sourceGroupBys.get(fieldName);
    fields[fieldName] = {
      ...entry,
      ...(values !== undefined && { values }),
      ...(options !== undefined && { options }),
      ...(groupBy !== undefined && { groupBy }),
    };
  }
  return fields;
};

export const projectPaths = (
  lensOrNarrowing: Lens | LensNarrowing,
  opts: ProjectLensOptions = {},
): PathProjection => {
  const policy = resolvePolicy(lensOrNarrowing);
  const out: PathProjection = {};

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
    if (Object.hasOwn(out, dottedPath)) return;
    const model = own(own(policy.lens.maps, mapName)?.models ?? {}, modelName);
    if (!model) return;

    const effect = resolveVisit(policy, mapName, modelName, relPath);

    // A sourced field's fetched pairs win; otherwise a value-gated field surfaces its resolved
    // allowed-set as options, so every selectable field exposes `options`.
    const fields = projectFields(effect, model, (field) => {
      const fetched = fetchedByPathField.get(`${dottedPath}|${field}`);
      const values = effect.enumValuesByField.get(field);
      return fetched ?? values?.map((value) => ({ value, label: value }));
    });

    const sources: Record<string, Condition[]> = {};
    for (const [fieldName, clauses] of effect.sources) {
      if (isFieldVisible(effect, fieldName)) sources[fieldName] = clauses;
    }

    const at = { mapName, modelName, relPath };
    const sourceLabels: Record<string, string> = {};
    for (const [fieldName, label] of effect.sourceLabels) {
      if (
        isFieldVisible(effect, fieldName) &&
        sourceReadsVisible(policy, effect, at, fieldName, 'label')
      )
        sourceLabels[fieldName] = label;
    }

    const sourceGroupBys: Record<string, string[]> = {};
    for (const [fieldName, groupBy] of effect.sourceGroupBys) {
      if (
        isFieldVisible(effect, fieldName) &&
        sourceReadsVisible(policy, effect, at, fieldName, 'groupBy')
      )
        sourceGroupBys[fieldName] = groupBy;
    }

    out[dottedPath] = {
      mapName,
      modelName,
      fields,
      whereClauses: effect.whereClauses,
      sources,
      sourceLabels,
      sourceGroupBys,
    };

    for (const relField of effect.relations.keys()) {
      // A relation this visit hides is not projected, as projectModels skips it.
      if (!isFieldVisible(effect, relField)) continue;
      const entry = own(model.fields, relField);
      if (!entry) continue;
      const target = relationTargetOf(entry, mapName);
      if (!target) continue;
      visit(target.mapName, target.modelName, [...relPath, relField], `${dottedPath}.${relField}`);
    }
  };

  visit(policy.lens.mapName, policy.lens.model, [], policy.lens.model);
  return out;
};
