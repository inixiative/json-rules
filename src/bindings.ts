import { mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

/**
 * Names of every `{ bind }` token reachable in a condition tree. The flat-set
 * shorthand a caller validates a bindings map against (`keys(bindings) ⊇ requiredBindings`).
 */
export const requiredBindings = (condition: Condition): Set<string> => {
  const names = new Set<string>();
  visitCondition(condition, undefined, {
    enter: (node) => {
      if (typeof node.bind === 'string') names.add(node.bind);
    },
  });
  return names;
};

/**
 * Replace each `{ bind }` token the map covers with its `{ value }`, leaving uncovered
 * tokens in place (partial / progressive resolution — `requiredBindings` shrinks). A node
 * may carry both its own value-bind and a nested condition (aggregate/array), so the
 * rewrite happens before descent. Does not mutate the input.
 */
export const resolveBindings = (
  condition: Condition,
  bindings: Record<string, RuleValue>,
): Condition =>
  mapCondition(condition, undefined, {
    rewrite: (node) => {
      if (typeof node.bind !== 'string' || !(node.bind in bindings)) return node;
      const { bind, ...rest } = node;
      // A supplied binding (key present) resolves to its value; undefined → null so
      // the substituted condition stays clean serializable JSON. Absent keys are
      // left as tokens (partial resolution), never coerced.
      const bound = bindings[bind as string];
      return { ...rest, value: bound === undefined ? null : bound };
    },
  });
