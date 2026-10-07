import { parseEndpointKey } from '../fieldMap/endpointKey.ts';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { Lens, LensNarrowing } from './types.ts';

export const isLens = (x: Lens | LensNarrowing): x is Lens => 'model' in x;

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

/** The lens a narrowing chain is rooted at. */
export const getRoot = (x: Lens | LensNarrowing): Lens =>
  isLens(x) ? x : (collectChain(x)[0].parent as Lens);

export const resolveRelationTarget = (
  entry: FieldMapEntry,
  currentMap: string,
): { mapName: string; modelName: string } | null => {
  if (entry.kind === 'object') return { mapName: currentMap, modelName: entry.type };
  if (entry.kind === 'bridge') return parseEndpointKey(entry.type, currentMap);
  return null;
};
