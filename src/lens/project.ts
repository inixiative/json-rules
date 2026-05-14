import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import type { Lens, LensNarrowing, ModelNarrowing } from './types.ts';

const isLens = (x: Lens | LensNarrowing): x is Lens => 'model' in x;

const getRoot = (x: Lens | LensNarrowing): Lens => (isLens(x) ? x : getRoot(x.parent));

const collectChain = (x: Lens | LensNarrowing): LensNarrowing[] => {
  const list: LensNarrowing[] = [];
  let cursor: Lens | LensNarrowing = x;
  while (!isLens(cursor)) {
    list.unshift(cursor);
    cursor = cursor.parent;
  }
  return list;
};

const asSet = (lens: Lens): FieldMapSet => {
  const first = Object.values(lens.map)[0];
  if (first && 'fields' in first) {
    const key = lens.mapName ?? 'default';
    return { [key]: lens.map as FieldMap };
  }
  return lens.map as FieldMapSet;
};

const resolveRelationTarget = (
  entry: FieldMapEntry,
  currentMap: string,
): { mapName: string; modelName: string } | null => {
  if (entry.kind === 'object') {
    return { mapName: currentMap, modelName: entry.type };
  }
  if (entry.kind === 'bridge') {
    const [m, n] = entry.type.includes(':') ? entry.type.split(':') : [currentMap, entry.type];
    return { mapName: m, modelName: n };
  }
  return null;
};

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
    // Always keep relation fields that have a sub-narrowing so descent is possible.
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
    const targetMap = set[target.mapName];
    if (!targetMap) continue;
    applyToModel(targetMap, target.modelName, target.mapName, set, sub);
  }
};

export const projectNarrowing = (lensOrNarrowing: Lens | LensNarrowing): FieldMapSet => {
  const root = getRoot(lensOrNarrowing);
  const set: FieldMapSet = structuredClone(asSet(root));
  const chain = collectChain(lensOrNarrowing);

  for (const narrowing of chain) {
    for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
      const fieldMap = set[mapName];
      if (!fieldMap) continue;
      for (const [modelName, modelNarrowing] of Object.entries(mapNarrowing.models)) {
        applyToModel(fieldMap, modelName, mapName, set, modelNarrowing);
      }
    }
  }

  return set;
};
