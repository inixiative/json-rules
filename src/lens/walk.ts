import type { FieldMapSet } from '../fieldMap/types.ts';
import { own } from '../own';
import type { FieldMapEntry, ModelEntry } from '../toPrisma/types.ts';
import type { Lens, LensNarrowing } from './types.ts';

export const isLens = (x: Lens | LensNarrowing): x is Lens => 'model' in x;

export const getRoot = (x: Lens | LensNarrowing): Lens => {
  const visited = new Set<LensNarrowing>();
  let cursor: Lens | LensNarrowing = x;
  while (!isLens(cursor)) {
    if (visited.has(cursor)) throw new Error('cycle detected in narrowing parent chain');
    visited.add(cursor);
    cursor = cursor.parent;
  }
  return cursor;
};

export const collectChain = (x: Lens | LensNarrowing): LensNarrowing[] => {
  const list: LensNarrowing[] = [];
  const visited = new Set<LensNarrowing>();
  let cursor: Lens | LensNarrowing = x;
  while (!isLens(cursor)) {
    if (visited.has(cursor)) throw new Error('cycle detected in narrowing parent chain');
    visited.add(cursor);
    list.unshift(cursor);
    cursor = cursor.parent;
  }
  return list;
};

/**
 * A Json column. It declares no sub-fields, so a dotted sub-path into it is open-ended —
 * `check`/`toPrisma`/`toSql` resolve the remaining segments against the JSON value at
 * evaluation time. Lens path resolution stops at this boundary.
 */
export const isJsonEntry = (entry: FieldMapEntry): boolean =>
  entry.kind === 'scalar' && entry.type === 'Json';

export const resolveRelationTarget = (
  entry: FieldMapEntry,
  currentMap: string,
): { mapName: string; modelName: string } | null => {
  if (entry.kind === 'object') return { mapName: currentMap, modelName: entry.type };
  if (entry.kind === 'bridge') {
    const [m, n] = entry.type.includes(':') ? entry.type.split(':') : [currentMap, entry.type];
    return { mapName: m, modelName: n };
  }
  return null;
};

export const walkPath = (
  set: FieldMapSet,
  startMap: string,
  startModel: string,
  path: string,
): { entry: FieldMapEntry; mapName: string; modelName: string } | null => {
  const parts = path.split('.');
  let mapName = startMap;
  let modelName = startModel;
  for (let i = 0; i < parts.length; i++) {
    const model: ModelEntry | undefined = set.maps[mapName]?.models[modelName];
    if (!model) return null;
    const entry = own(model.fields, parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { entry, mapName, modelName };
    const target = resolveRelationTarget(entry, mapName);
    if (!target) return null;
    mapName = target.mapName;
    modelName = target.modelName;
  }
  return null;
};
