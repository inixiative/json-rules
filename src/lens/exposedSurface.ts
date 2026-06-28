import type { Bridge, FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import { isFieldVisible, type Policy, resolvePolicy, resolveVisit } from './policy.ts';
import type { ProjectOptions } from './projectByPath.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

const modelKey = (mapName: string, modelName: string): string => `${mapName}::${modelName}`;

// A relPath matching no declared root.relations path → resolveVisit applies mapDefaults only.
const OFF_PATH: readonly string[] = ['__offpath__'];

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
  if (entry.values && existing.values) {
    const merged = new Set([...existing.values, ...entry.values]);
    fields.set(name, { ...existing, values: [...merged] });
  } else if (!entry.values && existing.values) {
    fields.set(name, { ...existing, values: undefined });
  }
};

// Leak-safe total exposed surface of a narrowed lens, as a Lens. See docs/LENS.md.
export const exposedSurface = (
  lensOrNarrowing: Lens | LensNarrowing,
  opts: ProjectOptions = {},
): Lens => {
  const policy: Policy = resolvePolicy(lensOrNarrowing);
  const { lens } = policy;

  // Per-model union of fetched values (the flattened surface collapses paths).
  const fetchedByModelField = new Map<string, Set<string>>();
  for (const sv of opts.sourceValues ?? []) {
    const k = `${sv.mapName}::${sv.model}::${sv.field}`;
    const set = fetchedByModelField.get(k) ?? new Set<string>();
    for (const v of sv.values) set.add(v);
    fetchedByModelField.set(k, set);
  }

  const surface = new Map<string, SurfaceModel>();
  const visitedDeclared = new Set<string>();
  const visitedOffPath = new Set<string>();

  type Visit = {
    mapName: string;
    modelName: string;
    relPath: readonly string[];
    declared: boolean;
  };
  const queue: Visit[] = [
    { mapName: lens.mapName, modelName: lens.model, relPath: [], declared: true },
  ];

  while (queue.length > 0) {
    const { mapName, modelName, relPath, declared } = queue.shift() as Visit;
    const model = lens.maps[mapName]?.models[modelName];
    if (!model) continue;

    const key = modelKey(mapName, modelName);
    if (declared) {
      const dkey = `${key}::${relPath.join('.')}`;
      if (visitedDeclared.has(dkey)) continue;
      visitedDeclared.add(dkey);
    } else {
      if (visitedOffPath.has(key)) continue;
      visitedOffPath.add(key);
    }

    const effect = resolveVisit(policy, mapName, modelName, declared ? relPath : OFF_PATH);

    let acc = surface.get(key);
    if (!acc) {
      acc = { mapName, modelName, fields: new Map() };
      surface.set(key, acc);
    }

    for (const [fieldName, entry] of Object.entries(model.fields)) {
      if (!isFieldVisible(effect, fieldName)) continue;
      const fetched = fetchedByModelField.get(`${mapName}::${modelName}::${fieldName}`);
      const values = fetched ? [...fetched] : effect.enumValuesByField.get(fieldName);
      unionFieldInto(acc.fields, fieldName, values !== undefined ? { ...entry, values } : entry);

      if (entry.kind === 'object' || entry.kind === 'bridge') {
        const target = resolveRelationTarget(entry, mapName);
        if (!target) continue;
        if (declared && effect.relations.has(fieldName)) {
          queue.push({
            mapName: target.mapName,
            modelName: target.modelName,
            relPath: [...relPath, fieldName],
            declared: true,
          });
        } else {
          queue.push({
            mapName: target.mapName,
            modelName: target.modelName,
            relPath: [],
            declared: false,
          });
        }
      }
    }
  }

  const maps: Record<string, FieldMap> = {};
  for (const { mapName, modelName, fields } of surface.values()) {
    let surfaceMap = maps[mapName];
    if (!surfaceMap) {
      surfaceMap = { models: {} };
      maps[mapName] = surfaceMap;
    }
    const fieldRecord: Record<string, FieldMapEntry> = {};
    const enumValuesByType = new Map<string, Set<string>>();
    for (const [name, entry] of fields) {
      fieldRecord[name] = entry;
      if (entry.kind === 'enum' && entry.values) {
        const set = enumValuesByType.get(entry.type) ?? new Set<string>();
        for (const v of entry.values) set.add(v);
        enumValuesByType.set(entry.type, set);
      }
    }
    surfaceMap.models[modelName] = {
      ...lens.maps[mapName]?.models[modelName],
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
    const aExposesB = maps[a.fieldMap]?.models[a.model]?.fields[`${bb.fieldMap}:${bb.model}`];
    const bExposesA = maps[bb.fieldMap]?.models[bb.model]?.fields[`${a.fieldMap}:${a.model}`];
    return aExposesB !== undefined || bExposesA !== undefined;
  });

  const result: FieldMapSet = { maps };
  if (bridges && bridges.length > 0) result.bridges = bridges;

  return { ...result, mapName: lens.mapName, model: lens.model };
};
