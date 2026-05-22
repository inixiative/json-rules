import type { Condition } from '../types.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { collectChain } from './walk.ts';

export const applyLens = (rule: Condition, narrowing: Lens | LensNarrowing): Condition => {
  const chain = collectChain(narrowing);
  const all: Condition[] = [];
  for (const n of chain) {
    if (n.constrains !== undefined) all.push(n.constrains);
  }
  return all.length ? { all: [...all, rule] } : rule;
};
