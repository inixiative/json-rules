import type { Lens, LensNarrowing } from './types.ts';

// A narrowing is what has a parent; a stray base-lens key on one must not end the chain early.
export const isLens = (x: Lens | LensNarrowing): x is Lens => !Object.hasOwn(x, 'parent');

export const collectChain = (x: Lens | LensNarrowing): LensNarrowing[] => {
  const list: LensNarrowing[] = [];
  const visited = new Set<LensNarrowing>();
  let cursor: Lens | LensNarrowing = x;
  while (!isLens(cursor)) {
    if (visited.has(cursor)) throw new Error('cycle detected in narrowing parent chain');
    if (Object.hasOwn(cursor, 'model') || Object.hasOwn(cursor, 'maps'))
      throw new Error(
        'a narrowing carries a base lens key (model / maps); it has a parent instead',
      );
    visited.add(cursor);
    list.unshift(cursor);
    cursor = cursor.parent;
  }
  return list;
};

/** The base lens a narrowing chain is rooted at; a lens is its own. Throws on a cyclic chain. */
export const getLensRoot = (x: Lens | LensNarrowing): Lens =>
  isLens(x) ? x : (collectChain(x)[0].parent as Lens);
