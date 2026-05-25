import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import { augmentPicksWithRelations, intersectStringSet } from './policy.ts';
import type { Lens, LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

// Accumulator for one (mapName, modelName) across all narrowing chain layers + paths.
// We collect all picks/omits/enumPicks/enumOmits first and apply once at the end —
// avoids the v2.0 last-write-wins bug where late picks erased earlier-picked fields.
type ModelAcc = {
  // null = no picks declared anywhere → keep all (subject to omits).
  // Non-null = intersection of all declared pick sets.
  picks: Set<string> | null;
  omits: Set<string>; // union
  // Per-field enum narrowing: field name → allowed values intersection.
  enumPicks: Map<string, Set<string>>;
  enumOmits: Map<string, Set<string>>; // per-field union
};

const newAcc = (): ModelAcc => ({
  picks: null,
  omits: new Set(),
  enumPicks: new Map(),
  enumOmits: new Map(),
});

const accumulateModelNarrowing = (
  acc: ModelAcc,
  n: ModelDefaultNarrowing | ModelNarrowing,
): void => {
  const augmented = augmentPicksWithRelations(n);
  if (augmented) acc.picks = intersectStringSet(acc.picks, augmented);
  if (n.omits) for (const f of n.omits) acc.omits.add(f);
  if (n.enumPicks) {
    for (const [field, values] of Object.entries(n.enumPicks)) {
      acc.enumPicks.set(field, intersectStringSet(acc.enumPicks.get(field) ?? null, values));
    }
  }
  if (n.enumOmits) {
    for (const [field, values] of Object.entries(n.enumOmits)) {
      const set = acc.enumOmits.get(field) ?? new Set<string>();
      for (const v of values) set.add(v);
      acc.enumOmits.set(field, set);
    }
  }
};

// Recursively walks a path-specific ModelNarrowing tree, accumulating each
// visited model's narrowing into the per-(map,model) accumulator.
const walkPathNarrowing = (
  set: FieldMapSet,
  mapName: string,
  modelName: string,
  modelNarrowing: ModelNarrowing,
  accs: Map<string, ModelAcc>,
): void => {
  const key = `${mapName}::${modelName}`;
  let acc = accs.get(key);
  if (!acc) {
    acc = newAcc();
    accs.set(key, acc);
  }
  accumulateModelNarrowing(acc, modelNarrowing);

  // Descend through relations to accumulate nested model narrowings.
  const model = set.maps[mapName]?.models[modelName];
  if (!model) return;
  for (const [relField, sub] of Object.entries(modelNarrowing.relations ?? {})) {
    const entry = model.fields[relField];
    if (!entry) continue;
    const target = resolveRelationTarget(entry, mapName);
    if (!target) continue;
    walkPathNarrowing(set, target.mapName, target.modelName, sub, accs);
  }
};

const narrowEnumValues = (
  current: readonly string[],
  picks: readonly string[] | undefined,
  omits: readonly string[] | undefined,
): readonly string[] => {
  let result = current;
  if (picks) {
    const pickSet = new Set(picks);
    result = result.filter((v) => pickSet.has(v));
  }
  if (omits) {
    const omitSet = new Set(omits);
    result = result.filter((v) => !omitSet.has(v));
  }
  return result;
};

export const projectNarrowing = (lensOrNarrowing: Lens | LensNarrowing): FieldMapSet => {
  const root = getRoot(lensOrNarrowing);
  const set: FieldMapSet = {
    maps: structuredClone(root.maps),
    bridges: root.bridges ? structuredClone(root.bridges) : undefined,
  };
  const chain = collectChain(lensOrNarrowing);

  // Phase 1: accumulate per-(map,model) narrowings across all chain layers.
  const accs = new Map<string, ModelAcc>();

  for (const narrowing of chain) {
    for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
      const fieldMap = set.maps[mapName];
      if (!fieldMap) continue;

      // defaults.models[M] applies wherever M is visited — add to every M's accumulator.
      const defaultsModels = mapNarrowing.defaults?.models ?? {};
      for (const [modelName, defaultsForModel] of Object.entries(defaultsModels)) {
        const key = `${mapName}::${modelName}`;
        let acc = accs.get(key);
        if (!acc) {
          acc = newAcc();
          accs.set(key, acc);
        }
        accumulateModelNarrowing(acc, defaultsForModel);
      }

      // Path-specific narrowings via models[M] (root) and its relations tree.
      for (const [modelName, modelNarrowing] of Object.entries(mapNarrowing.models)) {
        walkPathNarrowing(set, mapName, modelName, modelNarrowing, accs);
      }
    }
  }

  // Phase 1.5: narrow the enum registries via chained defaults.enums BEFORE
  // per-field narrowing reads from them (so field narrowing intersects against
  // the already-narrowed registry).
  for (const narrowing of chain) {
    for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
      const fieldMap = set.maps[mapName];
      if (!fieldMap?.enums) continue;
      for (const [enumName, enumNarrowing] of Object.entries(mapNarrowing.defaults?.enums ?? {})) {
        const current: readonly string[] | undefined = fieldMap.enums[enumName];
        if (!current) continue;
        fieldMap.enums = {
          ...fieldMap.enums,
          [enumName]: narrowEnumValues(current, enumNarrowing.picks, enumNarrowing.omits),
        };
      }
    }
  }

  // Phase 2: apply accumulated narrowings to each (map, model).
  for (const [key, acc] of accs) {
    const [mapName, modelName] = key.split('::');
    const model = set.maps[mapName]?.models[modelName];
    if (!model) continue;

    const fields = model.fields;
    const keep = acc.picks; // null → keep all (subject to omits)
    for (const fieldName of Object.keys(fields)) {
      const keptByPicks = keep === null || keep.has(fieldName);
      const droppedByOmits = acc.omits.has(fieldName);
      if (!keptByPicks || droppedByOmits) {
        delete fields[fieldName];
      }
    }

    // Apply per-field enum narrowing (sets FieldMapEntry.values).
    for (const [fieldName, entry] of Object.entries(fields)) {
      if (entry.kind !== 'enum') continue;
      const enumRegistry = set.maps[mapName]?.enums?.[entry.type];
      const baseValues: readonly string[] | undefined = entry.values ?? enumRegistry;
      const picks = acc.enumPicks.get(fieldName);
      const omits = acc.enumOmits.get(fieldName);
      if (!baseValues && !picks && !omits) continue;
      const start = baseValues ?? [];
      const narrowed = narrowEnumValues(
        start,
        picks ? Array.from(picks) : undefined,
        omits ? Array.from(omits) : undefined,
      );
      (entry as FieldMapEntry).values = narrowed;
    }
  }

  // Phase 3: prune bridges whose endpoint bridge-key fields were narrowed away.
  if (set.bridges) {
    set.bridges = set.bridges.filter((bridge) => {
      const [a, b] = bridge.endpoints;
      const aBridgeKey = `${b.fieldMap}:${b.model}`;
      const bBridgeKey = `${a.fieldMap}:${a.model}`;
      const aHasKey = set.maps[a.fieldMap]?.models[a.model]?.fields[aBridgeKey] !== undefined;
      const bHasKey = set.maps[b.fieldMap]?.models[b.model]?.fields[bBridgeKey] !== undefined;
      return aHasKey && bHasKey;
    });
  }

  return set;
};

// Suppress unused FieldMap import — kept for future use if signature widens.
export type _ProjectNarrowingFieldMap = FieldMap;
