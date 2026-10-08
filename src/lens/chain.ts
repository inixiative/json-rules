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

/** The base lens a narrowing chain is rooted at; a lens is its own. Throws on a cyclic chain. */
export const getLensRoot = (x: Lens | LensNarrowing): Lens =>
  isLens(x) ? x : (collectChain(x)[0].parent as Lens);
