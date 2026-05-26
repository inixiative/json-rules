import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import { accumulateEnumFields, accumulatePicksOmitsInto } from './policy.ts';
import type { Lens, LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

type ModelAcc = {
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

const fieldVisibleAtPath = (acc: ModelAcc, f: string): boolean => {
  if (acc.omits.has(f)) return false;
  if (acc.picks !== null && !acc.picks.has(f)) return false;
  return true;
};

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

  const pathAccs = new Map<string, ModelAcc>();
  const pathToModel = new Map<string, { mapName: string; modelName: string }>();
  for (const narrowing of chain) {
    if (narrowing.root) {
      walkPathNarrowing(
        set,
        root.mapName,
        root.model,
        root.model,
        narrowing.root,
        pathAccs,
        pathToModel,
      );
    }
  }

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
      if (fieldMap.enums) {
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
  }

  const pathAccsByModel = new Map<string, ModelAcc[]>();
  for (const [pathKey, acc] of pathAccs) {
    const target = pathToModel.get(pathKey);
    if (!target) continue;
    const modelKey = `${target.mapName}::${target.modelName}`;
    const list = pathAccsByModel.get(modelKey) ?? [];
    list.push(acc);
    pathAccsByModel.set(modelKey, list);
  }

  for (const [mapName, fieldMap] of Object.entries(set.maps)) {
    for (const [modelName, model] of Object.entries(fieldMap.models)) {
      const modelKey = `${mapName}::${modelName}`;
      const sibAccs = pathAccsByModel.get(modelKey);
      const defAcc = defaultAccs.get(modelKey);
      if (!sibAccs && !defAcc) continue;

      for (const f of Object.keys(model.fields)) {
        const visibleViaPaths = sibAccs ? sibAccs.some((a) => fieldVisibleAtPath(a, f)) : true;
        const visibleViaDefaults = defAcc ? fieldVisibleAtPath(defAcc, f) : true;
        if (!visibleViaPaths || !visibleViaDefaults) delete model.fields[f];
      }

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
        const baseValues: readonly string[] | undefined =
          entry.values ?? fieldMap.enums?.[entry.type];
        if (!baseValues) continue;
        (entry as FieldMapEntry).values = baseValues.filter((v) => {
          const visibleViaPaths = sibAccs
            ? sibAccs.some((a) => enumValueVisibleAtPath(a, fieldName, v))
            : true;
          const visibleViaDefaults = defAcc ? enumValueVisibleAtPath(defAcc, fieldName, v) : true;
          return visibleViaPaths && visibleViaDefaults;
        });
      }
    }
  }

  if (set.bridges) {
    set.bridges = set.bridges.filter((bridge) => {
      const [a, b] = bridge.endpoints;
      const aHasKey =
        set.maps[a.fieldMap]?.models[a.model]?.fields[`${b.fieldMap}:${b.model}`] !== undefined;
      const bHasKey =
        set.maps[b.fieldMap]?.models[b.model]?.fields[`${a.fieldMap}:${a.model}`] !== undefined;
      return aHasKey && bHasKey;
    });
  }

  return set;
};
