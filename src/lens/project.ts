import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import { accumulateEnumFields, accumulatePicksOmitsInto } from './policy.ts';
import type { Lens, LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

// Per-path or per-model accumulator. Chain composition WITHIN a key intersects
// picks / unions omits — that's the monotonic-restriction semantic.
type ModelAcc = {
  // null = no picks declared at this key → all fields visible (subject to omits).
  picks: Set<string> | null;
  omits: Set<string>;
  enumPicks: Map<string, Set<string>>;
  enumOmits: Map<string, Set<string>>;
};

const newAcc = (): ModelAcc => ({
  picks: null,
  omits: new Set(),
  enumPicks: new Map(),
  enumOmits: new Map(),
});

const accumulateIntersect = (acc: ModelAcc, n: ModelDefaultNarrowing | ModelNarrowing): void => {
  accumulatePicksOmitsInto(acc, n);
  accumulateEnumFields(acc.enumPicks, acc.enumOmits, n);
};

// Walks a path-specific narrowing tree, accumulating each visit into a
// path-keyed accumulator: `${mapName}::${dottedPath}`. Two sibling relations to
// the same model produce distinct keys, so their picks never collapse.
// `pathToModel` records which (map, model) each path key resolves to so we can
// group sibling paths by model later for the union step.
const walkPathNarrowing = (
  set: FieldMapSet,
  mapName: string,
  modelName: string,
  dottedPath: string,
  modelNarrowing: ModelNarrowing,
  pathAccs: Map<string, ModelAcc>,
  pathToModel: Map<string, { mapName: string; modelName: string }>,
): void => {
  const key = `${mapName}::${dottedPath}`;
  let acc = pathAccs.get(key);
  if (!acc) {
    acc = newAcc();
    pathAccs.set(key, acc);
    pathToModel.set(key, { mapName, modelName });
  }
  accumulateIntersect(acc, modelNarrowing);

  const model = set.maps[mapName]?.models[modelName];
  if (!model) return;
  for (const [relField, sub] of Object.entries(modelNarrowing.relations ?? {})) {
    const entry = model.fields[relField];
    if (!entry) continue;
    const target = resolveRelationTarget(entry, mapName);
    if (!target) continue;
    walkPathNarrowing(
      set,
      target.mapName,
      target.modelName,
      `${dottedPath}.${relField}`,
      sub,
      pathAccs,
      pathToModel,
    );
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

// At a single path, is field f visible? (picks=null means all visible.)
const fieldVisibleAtPath = (acc: ModelAcc, f: string): boolean => {
  if (acc.omits.has(f)) return false;
  if (acc.picks !== null && !acc.picks.has(f)) return false;
  return true;
};

// At a single path, is enum value v visible for field f?
const enumValueVisibleAtPath = (acc: ModelAcc, f: string, v: string): boolean => {
  const p = acc.enumPicks.get(f);
  const o = acc.enumOmits.get(f);
  if (o?.has(v)) return false;
  if (p && !p.has(v)) return false;
  return true;
};

export const projectNarrowing = (lensOrNarrowing: Lens | LensNarrowing): FieldMapSet => {
  const root = getRoot(lensOrNarrowing);
  const set: FieldMapSet = {
    maps: structuredClone(root.maps),
    bridges: root.bridges ? structuredClone(root.bridges) : undefined,
  };
  const chain = collectChain(lensOrNarrowing);

  // Phase 1: path-specific narrowings → per-path acc, keyed by dotted path.
  // Chain composition WITHIN a path intersects (monotonic restriction).
  const pathAccs = new Map<string, ModelAcc>();
  const pathToModel = new Map<string, { mapName: string; modelName: string }>();
  for (const narrowing of chain) {
    if (narrowing.root) {
      walkPathNarrowing(
        set,
        root.mapName,
        root.model,
        root.model, // dottedPath for the root visit is just the lens anchor model name
        narrowing.root,
        pathAccs,
        pathToModel,
      );
    }
  }

  // Phase 2: mapDefaults → per-model acc (truly applies-everywhere).
  const defaultAccs = new Map<string, ModelAcc>();
  for (const narrowing of chain) {
    for (const [mapName, defaults] of Object.entries(narrowing.mapDefaults ?? {})) {
      const fieldMap = set.maps[mapName];
      if (!fieldMap) continue;
      for (const [modelName, defaultsForModel] of Object.entries(defaults.models ?? {})) {
        const key = `${mapName}::${modelName}`;
        let acc = defaultAccs.get(key);
        if (!acc) {
          acc = newAcc();
          defaultAccs.set(key, acc);
        }
        accumulateIntersect(acc, defaultsForModel);
      }
    }
  }

  // Phase 2.5: narrow enum registries via chained mapDefaults.enums BEFORE
  // per-field narrowing reads from them.
  for (const narrowing of chain) {
    for (const [mapName, defaults] of Object.entries(narrowing.mapDefaults ?? {})) {
      const fieldMap = set.maps[mapName];
      if (!fieldMap?.enums) continue;
      for (const [enumName, enumNarrowing] of Object.entries(defaults.enums ?? {})) {
        const current: readonly string[] | undefined = fieldMap.enums[enumName];
        if (!current) continue;
        fieldMap.enums = {
          ...fieldMap.enums,
          [enumName]: narrowEnumValues(current, enumNarrowing.picks, enumNarrowing.omits),
        };
      }
    }
  }

  // Phase 3: group path accs by (map, model) so sibling paths to the same
  // model can be unioned in the projection.
  const pathAccsByModel = new Map<string, ModelAcc[]>();
  for (const [pathKey, acc] of pathAccs) {
    const target = pathToModel.get(pathKey);
    if (!target) continue;
    const modelKey = `${target.mapName}::${target.modelName}`;
    const list = pathAccsByModel.get(modelKey) ?? [];
    list.push(acc);
    pathAccsByModel.set(modelKey, list);
  }

  // Phase 4: apply visibility = (∃ path where visible) ∩ mapDefaults.
  for (const [mapName, fieldMap] of Object.entries(set.maps)) {
    for (const [modelName, model] of Object.entries(fieldMap.models)) {
      const modelKey = `${mapName}::${modelName}`;
      const sibAccs = pathAccsByModel.get(modelKey);
      const defAcc = defaultAccs.get(modelKey);
      if (!sibAccs && !defAcc) continue;

      const allFields = Object.keys(model.fields);

      for (const f of allFields) {
        // visible-at-any-path: if no paths reach this model, treat as fully visible.
        const visibleViaPaths = sibAccs ? sibAccs.some((a) => fieldVisibleAtPath(a, f)) : true;
        const visibleViaDefaults = defAcc ? fieldVisibleAtPath(defAcc, f) : true;
        if (!visibleViaPaths || !visibleViaDefaults) {
          delete model.fields[f];
        }
      }

      // Per-field enum narrowing: union allowed values across sibling paths,
      // then intersect with mapDefaults for the field.
      const enumFieldsInPlay = new Set<string>();
      for (const acc of sibAccs ?? []) {
        for (const f of acc.enumPicks.keys()) enumFieldsInPlay.add(f);
        for (const f of acc.enumOmits.keys()) enumFieldsInPlay.add(f);
      }
      if (defAcc) {
        for (const f of defAcc.enumPicks.keys()) enumFieldsInPlay.add(f);
        for (const f of defAcc.enumOmits.keys()) enumFieldsInPlay.add(f);
      }

      for (const fieldName of enumFieldsInPlay) {
        const entry = model.fields[fieldName];
        if (!entry || entry.kind !== 'enum') continue;
        const enumRegistry = fieldMap.enums?.[entry.type];
        const baseValues: readonly string[] | undefined = entry.values ?? enumRegistry;
        if (!baseValues) continue;

        const narrowed = baseValues.filter((v) => {
          const visibleViaPaths = sibAccs
            ? sibAccs.some((a) => enumValueVisibleAtPath(a, fieldName, v))
            : true;
          const visibleViaDefaults = defAcc ? enumValueVisibleAtPath(defAcc, fieldName, v) : true;
          return visibleViaPaths && visibleViaDefaults;
        });
        (entry as FieldMapEntry).values = narrowed;
      }
    }
  }

  // Phase 5: prune bridges whose endpoint bridge-key fields were narrowed away.
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
