import type { Bridge, FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import { isFieldVisible, type Policy, resolvePolicy, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

const modelKey = (mapName: string, modelName: string): string => `${mapName}::${modelName}`;

// A relPath that matches no declared root.relations path, so resolveVisit applies
// mapDefaults only (never root). Used for visits reached off the declared tree.
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
  // Same field reached via another path — union the allowed enum values (a value
  // exposed on any reachable path belongs in the total exposed surface).
  if (entry.values && existing.values) {
    const merged = new Set([...existing.values, ...entry.values]);
    fields.set(name, { ...existing, values: [...merged] });
  } else if (!entry.values && existing.values) {
    fields.set(name, { ...existing, values: undefined });
  }
};

/**
 * Produces the total exposed surface of a (possibly narrowed) lens as a **Lens**
 * (maps intact — the navigable graph), NOT a projection (path-keyed view). This
 * is the leak-safe server→client surface: every model reachable from the anchor
 * through visible relation/bridge edges, with the FULL narrowing applied — root
 * at the anchor, path-specific narrowing along declared relation paths,
 * model-default (`mapDefaults`) everywhere else — then unioned per model. A field
 * appears iff it is visible on at least one reachable, narrowed path; fields
 * hidden on every path (including those hidden only by `root`) are absent, so it
 * never exposes the raw, un-narrowed lens.
 *
 * `where` (data-scope) narrowing is dropped — this is the client schema surface.
 * For a server→subtenant handoff that must preserve `where` and per-path
 * narrowing, use `seal` (planned) instead. Per-path divergence (a model that
 * looks different at two sibling paths) is not represented here; pair with
 * `projectByPath` when that distinction matters.
 *
 * Cycle-safe: declared-path visits are keyed by path (the declared tree is
 * finite) and off-path visits by model (visited once), so recursive schemas
 * (User → Org → members(User) → …) terminate.
 */
export const exposedSurface = (lensOrNarrowing: Lens | LensNarrowing): Lens => {
  const policy: Policy = resolvePolicy(lensOrNarrowing);
  const { lens } = policy;

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
      const narrowedEnum = effect.enumValuesByField.get(fieldName);
      unionFieldInto(
        acc.fields,
        fieldName,
        narrowedEnum !== undefined ? { ...entry, values: narrowedEnum } : entry,
      );

      if (entry.kind === 'object' || entry.kind === 'bridge') {
        const target = resolveRelationTarget(entry, mapName);
        if (!target) continue;
        // Stay on the declared tree only while this relation has declared sub-narrowing;
        // otherwise descend as an off-path (mapDefaults-only) visit.
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

    // Registry reflects the narrowed, exposed values only (union of field values),
    // never the raw source enum — so it can't leak narrowed-away values.
    for (const [enumType, values] of enumValuesByType) {
      surfaceMap.enums ??= {};
      surfaceMap.enums[enumType] = [...values];
    }
  }

  // Eliminate any bridge that touches an unexposed surface: keep a bridge only if
  // at least one of its injected bridge-fields survived in the exposed surface.
  // (stitchFieldMaps injects field `"<b.fieldMap>:<b.model>"` on a's model and
  // `"<a.fieldMap>:<a.model>"` on b's model.) This prevents a bridge — and its
  // `on` join keys — from leaking when the relationship isn't navigable in the
  // surface, while leaving the surface's fields themselves untouched.
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
