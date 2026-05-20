import type { Condition } from '../types.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { getRoot, isLens } from './walk.ts';

export const applyLens = (rule: Condition, narrowing: Lens | LensNarrowing): Condition => {
  const all: Condition[] = [];
  let c: Lens | LensNarrowing = narrowing;
  while (!isLens(c)) {
    if (c.constrains) all.unshift(c.constrains);
    c = c.parent;
  }
  return all.length ? { all: [...all, rule] } : rule;
};

export const getSources = (narrowing: Lens | LensNarrowing): Record<string, unknown> =>
  getRoot(narrowing).sources ?? {};
