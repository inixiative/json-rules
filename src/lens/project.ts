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
  modelNarrowing: ModelNarrowing,
  accs: Map<string, ModelAcc>,
): void => {
  const key = `${mapName}::${modelName}`;
  let acc = accs.get(key);
  if (!acc) {
    acc = newAcc();
    accs.set(key, acc);
  }
  accumulateIntersect(acc, modelNarrowing);

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

  const accs = new Map<string, ModelAcc>();

  for (const narrowing of chain) {
    for (const [mapName, defaults] of Object.entries(narrowing.mapDefaults ?? {})) {
      const fieldMap = set.maps[mapName];
      if (!fieldMap) continue;
      for (const [modelName, defaultsForModel] of Object.entries(defaults.models ?? {})) {
        const key = `${mapName}::${modelName}`;
        let acc = accs.get(key);
        if (!acc) {
          acc = newAcc();
          accs.set(key, acc);
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

    if (narrowing.root) {
      walkPathNarrowing(set, root.mapName, root.model, narrowing.root, accs);
    }
  }

  for (const [key, acc] of accs) {
    const [mapName, modelName] = key.split('::');
    const model = set.maps[mapName]?.models[modelName];
    if (!model) continue;

    const fields = model.fields;
    const keep = acc.picks;
    for (const fieldName of Object.keys(fields)) {
      const keptByPicks = keep === null || keep.has(fieldName);
      const droppedByOmits = acc.omits.has(fieldName);
      if (!keptByPicks || droppedByOmits) delete fields[fieldName];
    }

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
