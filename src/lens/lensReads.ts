import { relationTargetOf } from '../fieldMap/walk';
import type { Condition } from '../types';
import { lensRootScope, type Policy, resolvePolicyPath } from './policy.ts';
import { readPaths } from './readPaths';

/** A model a rule reads, and the relation path from the lens anchor that reaches it (`''` for the
 *  anchor itself). */
export type LensRead = { model: string; path: string };

/**
 * Every model a condition reads through the lens, with the relation path that reaches it. Each
 * relation crossed counts as a read of the model it leads to — a change to which rows it reaches
 * changes what the rule sees — and a column counts as a read of the model it sits on. A path the
 * lens doesn't resolve is left to `validateRuleInLens` to report.
 */
export const lensReads = (policy: Policy, condition: Condition): LensRead[] => {
  const found = new Map<string, LensRead>();
  const add = (model: string, relPath: readonly string[]): void => {
    const path = relPath.join('.');
    found.set(`${path}\u0000${model}`, { model, path });
  };
  for (const path of readPaths(condition)) {
    const { resolution } = resolvePolicyPath(policy, lensRootScope(policy), path);
    if (resolution.outcome !== 'resolved') continue;
    for (const hop of resolution.hops) {
      const target = relationTargetOf(hop.entry, hop.mapName);
      if (target) add(target.modelName, [...hop.relPath, hop.field]);
      else add(hop.model, hop.relPath);
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, read]) => read);
};
