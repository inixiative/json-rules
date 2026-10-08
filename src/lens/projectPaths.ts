import type { FieldMapEntry, ModelEntry, SourceOption } from '../fieldMap/types';
import { type MapVisit, walkMaps } from '../fieldMap/walk.ts';
import { modelOf, own } from '../own';
import type { Condition } from '../types.ts';
import {
  declaresModelSource,
  isFieldVisible,
  type Policy,
  resolvePolicy,
  resolveVisit,
  shownVisits,
  sourceReadsVisible,
  undeclaredModelSource,
  type VisitEffect,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type ProjectedVisit = {
  mapName: string;
  model: string;
  fields: Record<string, FieldMapEntry>;
  whereClauses: Condition[];
  /** Per-field source eligibility wheres, composed across layers (general + path). */
  sources: Record<string, Condition[]>;
  /** Per-field display label for a sourced field (from a SourceSpec's `label`): a sibling
   * column or a dotted to-one path. */
  sourceLabels: Record<string, string>;
  /** Per-field option-partition axes for a sourced field (from a SourceSpec's `groupBy`). */
  sourceGroupBys: Record<string, string[]>;
  /** Sourced fields that offer their model's own source (`from: 'mapDefaults'`) rather than
   *  the rows reachable down this path. */
  sourceFrom: Record<string, 'mapDefaults'>;
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
 * One visit's fields as the lens exposes them: the visible columns and the relations turned on, a value-gated field carrying
 * its allowed `values`, fetched source `options` attached, and a grouped source's `groupBy` axes.
 * Both projections build their fields through it.
 */
export const projectFields = (
  policy: Policy,
  effect: VisitEffect,
  at: MapVisit,
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
    // Axes a layer hides drop, as they do from the visit's sourceGroupBys.
    const groupBy = sourceReadsVisible(policy, effect, at, fieldName, 'groupBy')
      ? effect.sourceGroupBys.get(fieldName)
      : undefined;
    fields[fieldName] = {
      ...entry,
      ...(values !== undefined && { values }),
      ...(options !== undefined && { options }),
      ...(groupBy !== undefined && { groupBy }),
    };
  }
  return fields;
};

// One shown visit as the projection gives it, at `dottedPath` (the anchor model, then relations).
const projectVisit = (
  policy: Policy,
  at: MapVisit,
  effect: VisitEffect,
  dottedPath: string,
  fetchedByPathField: ReadonlyMap<string, readonly SourceOption[]>,
): ProjectedVisit => {
  const { mapName, modelName } = at;
  const model = modelOf(own(policy.lens.maps, mapName), modelName) as ModelEntry;

  // A sourced field's fetched pairs win; then the options the map declares (labels and groups
  // kept); otherwise a value-gated field surfaces its resolved allowed-set as options, so every
  // selectable field exposes `options`.
  const fields = projectFields(policy, effect, at, model, (field) => {
    const fetched = fetchedByPathField.get(`${dottedPath}|${field}`);
    const values = effect.enumValuesByField.get(field);
    return (
      fetched ??
      own(model.fields, field)?.options ??
      values?.map((value) => ({ value, label: value }))
    );
  });

  const sources: Record<string, Condition[]> = {};
  for (const [fieldName, clauses] of effect.sources) {
    if (isFieldVisible(effect, fieldName)) sources[fieldName] = clauses;
  }

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

  const sourceFrom: Record<string, 'mapDefaults'> = {};
  for (const fieldName of effect.sourcesFromMapDefaults.keys()) {
    if (!declaresModelSource(policy, mapName, modelName, fieldName))
      throw undeclaredModelSource(dottedPath, mapName, modelName, fieldName);
    if (Object.hasOwn(sources, fieldName)) sourceFrom[fieldName] = 'mapDefaults';
  }

  return {
    mapName,
    model: modelName,
    fields,
    whereClauses: effect.whereClauses,
    sources,
    sourceLabels,
    sourceGroupBys,
    sourceFrom,
  };
};

const fetchedBy = (opts: ProjectLensOptions): Map<string, readonly SourceOption[]> => {
  const out = new Map<string, readonly SourceOption[]>();
  for (const sv of opts.sourceValues ?? []) out.set(`${sv.path}|${sv.field}`, sv.options);
  return out;
};

export const projectPaths = (
  lensOrNarrowing: Lens | LensNarrowing,
  opts: ProjectLensOptions = {},
): PathProjection => projectPathsWith(resolvePolicy(lensOrNarrowing), opts);

export const projectPathsWith = (policy: Policy, opts: ProjectLensOptions = {}): PathProjection => {
  const fetched = fetchedBy(opts);
  const out: PathProjection = {};
  for (const { path, at, effect } of shownVisits(policy))
    out[path] = projectVisit(policy, at, effect, path, fetched);
  return out;
};

/**
 * One visit as `projectLens` (by path) gives it, resolved on demand: `relationPath` is the dotted
 * relation path from the lens anchor (`''` for the anchor). Null when a relation on it isn't shown
 * there — off, omitted, or outside the model-default tree. Nothing is
 * enumerated, so it is cheap on any schema.
 */
export const lensVisit = (
  lensOrNarrowing: Lens | LensNarrowing,
  relationPath: string,
  opts: ProjectLensOptions = {},
): ProjectedVisit | null => lensVisitWith(resolvePolicy(lensOrNarrowing), relationPath, opts);

export const lensVisitWith = (
  policy: Policy,
  relationPath: string,
  opts: ProjectLensOptions = {},
): ProjectedVisit | null => {
  let at: MapVisit = {
    mapName: policy.lens.mapName,
    modelName: policy.lens.model,
    relPath: [],
  };
  if (relationPath !== '')
    for (const step of walkMaps(policy.lens.maps, at, relationPath)) {
      const shown = resolveVisit(policy, step.at.mapName, step.at.modelName, step.at.relPath);
      if (!step.next || !shown.relations.has(step.field)) return null;
      at = { ...step.next, relPath: [...step.at.relPath, step.field] };
    }
  if (!modelOf(own(policy.lens.maps, at.mapName), at.modelName)) return null;
  const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
  const dottedPath = [policy.lens.model, ...at.relPath].join('.');
  return projectVisit(policy, at, effect, dottedPath, fetchedBy(opts));
};
