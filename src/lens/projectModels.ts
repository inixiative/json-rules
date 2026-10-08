import { endpointKey } from '../fieldMap/endpointKey.ts';
import type { Bridge, FieldMap, FieldMapEntry, FieldMapSet, SourceOption } from '../fieldMap/types';
import { fieldOf, modelOf, own } from '../own';
import { type Policy, resolvePolicy, shownVisits } from './policy.ts';
import { type ProjectLensOptions, projectFields } from './projectPaths.ts';
import { optionKey } from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

const modelKey = (mapName: string, modelName: string): string => `${mapName}::${modelName}`;

type SurfaceModel = { mapName: string; modelName: string; fields: Map<string, FieldMapEntry> };

const unionFieldInto = (
  fields: Map<string, FieldMapEntry>,
  name: string,
  entry: FieldMapEntry,
): void => {
  const existing = fields.get(name);
  if (!existing) {
    fields.set(name, entry.values ? { ...entry, values: [...entry.values] } : entry);
    return;
  }
  let next = existing;
  if (entry.values && existing.values) {
    const merged = new Set([...existing.values, ...entry.values]);
    next = { ...next, values: [...merged] };
  } else if (!entry.values && existing.values) {
    next = { ...next, values: undefined };
  }
  // A later visit may carry the partition axes an earlier visit lacked; divergence was
  // already rejected before this merge.
  if (entry.groupBy !== undefined && next.groupBy === undefined) {
    next = { ...next, groupBy: entry.groupBy };
  }
  if (next !== existing) fields.set(name, next);
};

// Leak-safe total exposed surface of a narrowed lens, as a Lens. See docs/LENS.md.
export const projectModels = (
  lensOrNarrowing: Lens | LensNarrowing,
  opts: ProjectLensOptions = {},
): Lens => {
  const policy: Policy = resolvePolicy(lensOrNarrowing);
  const { lens } = policy;

  // Per-model union of fetched options (the flattened surface collapses paths):
  // dedup by (group, value) across paths — the same key the materializers use —
  // so a grouped field's partition survives the union; a later occurrence wins.
  const fetchedByModelField = new Map<string, Map<string, SourceOption>>();
  for (const sv of opts.sourceValues ?? []) {
    const k = `${sv.mapName}::${sv.model}::${sv.field}`;
    const byKey = fetchedByModelField.get(k) ?? new Map<string, SourceOption>();
    for (const o of sv.options) byKey.set(optionKey(o.groups, o.value), o);
    fetchedByModelField.set(k, byKey);
  }

  const surface = new Map<string, SurfaceModel>();
  for (const { at, effect } of shownVisits(policy)) {
    const { mapName, modelName } = at;
    const model = modelOf(own(lens.maps, mapName), modelName);
    if (!model) continue;
    const key = modelKey(mapName, modelName);
    let acc = surface.get(key);
    if (!acc) {
      acc = { mapName, modelName, fields: new Map() };
      surface.set(key, acc);
    }

    const fields = projectFields(policy, effect, at, model, (field) => {
      const fetched = fetchedByModelField.get(`${mapName}::${modelName}::${field}`);
      return fetched && [...fetched.values()];
    });
    for (const [fieldName, nextEntry] of Object.entries(fields)) {
      // The surface flattens per model: two paths grouping one field by DIFFERENT axes would
      // union two incompatible partition namespaces — fail loud instead of merging them.
      const axes = nextEntry.groupBy;
      const existing = acc.fields.get(fieldName)?.groupBy;
      if (
        axes !== undefined &&
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(axes)
      )
        throw new Error(
          `projectLens: '${modelName}.${fieldName}' is grouped by different axes on different paths ([${existing}] vs [${axes}]) — one surface field cannot carry two partition namespaces`,
        );
      unionFieldInto(acc.fields, fieldName, nextEntry);
    }
  }

  const maps: Record<string, FieldMap> = {};
  for (const { mapName, modelName, fields } of surface.values()) {
    let surfaceMap = own(maps, mapName);
    if (!surfaceMap) {
      surfaceMap = { models: {} };
      maps[mapName] = surfaceMap;
    }
    const fieldRecord: Record<string, FieldMapEntry> = {};
    const enumValuesByType = new Map<string, Set<string>>();
    for (const [name, entry] of fields) {
      // A sourced field already carries fetched `options`; otherwise a value-gated
      // field surfaces its (unioned) allowed-set as options, so every selectable
      // field exposes `options` uniformly. `values` stays as the validation input.
      fieldRecord[name] =
        entry.options === undefined && entry.values
          ? { ...entry, options: entry.values.map((v) => ({ value: v, label: v })) }
          : entry;
      if (entry.kind === 'enum' && entry.values) {
        const set = enumValuesByType.get(entry.type) ?? new Set<string>();
        for (const v of entry.values) set.add(v);
        enumValuesByType.set(entry.type, set);
      }
    }
    surfaceMap.models[modelName] = {
      ...modelOf(own(lens.maps, mapName), modelName),
      fields: fieldRecord,
    };

    for (const [enumType, values] of enumValuesByType) {
      surfaceMap.enums ??= {};
      surfaceMap.enums[enumType] = [...values];
    }
  }

  // Keep a bridge only if one of its injected bridge-fields survived (else it
  // touches unexposed surface and its `on` keys would leak).
  const bridges: Bridge[] | undefined = lens.bridges?.filter((b) => {
    const [a, bb] = b.endpoints;
    const aExposesB = fieldOf(own(maps, a.fieldMap), a.model, endpointKey(bb));
    const bExposesA = fieldOf(own(maps, bb.fieldMap), bb.model, endpointKey(a));
    return aExposesB !== undefined || bExposesA !== undefined;
  });

  const result: FieldMapSet = { maps };
  if (bridges && bridges.length > 0) result.bridges = bridges;

  return { ...result, mapName: lens.mapName, model: lens.model };
};
