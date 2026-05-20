import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap } from '../toPrisma/types.ts';
import type { Lens, LensNarrowing, ModelNarrowing } from './types.ts';
import { asSet, collectChain, getRoot, resolveRelationTarget } from './walk.ts';

const applyToModel = (
  fieldMap: FieldMap,
  modelName: string,
  mapName: string,
  set: FieldMapSet,
  narrowing: ModelNarrowing,
): void => {
  const model = fieldMap[modelName];
  if (!model) return;

  if (narrowing.picks) {
    const keep = new Set(narrowing.picks);
    for (const r of Object.keys(narrowing.relations ?? {})) keep.add(r);
    for (const f of Object.keys(model.fields)) {
      if (!keep.has(f)) delete model.fields[f];
    }
  }
  if (narrowing.omits) {
    for (const f of narrowing.omits) delete model.fields[f];
  }

  for (const [relField, sub] of Object.entries(narrowing.relations ?? {})) {
    const entry = model.fields[relField];
    if (!entry) continue;
    const target = resolveRelationTarget(entry, mapName);
    if (!target) continue;
    const targetMap = set.maps[target.mapName];
    if (!targetMap) continue;
    applyToModel(targetMap, target.modelName, target.mapName, set, sub);
  }
};

export const projectNarrowing = (lensOrNarrowing: Lens | LensNarrowing): FieldMapSet => {
  const root = getRoot(lensOrNarrowing);
  const source = asSet(root);
  const set: FieldMapSet = { maps: structuredClone(source.maps), bridges: source.bridges };
  const chain = collectChain(lensOrNarrowing);

  for (const narrowing of chain) {
    for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
      const fieldMap = set.maps[mapName];
      if (!fieldMap) continue;
      for (const [modelName, modelNarrowing] of Object.entries(mapNarrowing.models)) {
        applyToModel(fieldMap, modelName, mapName, set, modelNarrowing);
      }
    }
  }

  return set;
};
