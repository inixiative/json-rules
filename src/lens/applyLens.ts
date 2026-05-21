import type { Condition } from '../types.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { collectChain, getRoot } from './walk.ts';

export const applyLens = (rule: Condition, narrowing: Lens | LensNarrowing): Condition => {
  const chain = collectChain(narrowing);
  const all: Condition[] = [];
  for (const n of chain) {
    if (n.constrains) all.push(n.constrains);
  }
  return all.length ? { all: [...all, rule] } : rule;
};

export const getSources = (narrowing: Lens | LensNarrowing): Record<string, unknown> =>
  getRoot(narrowing).sources ?? {};
