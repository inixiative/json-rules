import { mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

/** Names of every `{ bind }` token in the tree — the set a bindings map must cover. */
export const requiredBindings = (condition: Condition): Set<string> => {
  const names = new Set<string>();
  visitCondition(condition, {
    enter: (node) => {
      if (typeof node.bind === 'string') names.add(node.bind);
    },
  });
  return names;
};

/**
 * Substitute covered binds with their values; uncovered tokens stay in place (partial
 * resolution). A supplied-but-undefined binding becomes null to stay serializable.
 * Non-mutating.
 */
export const resolveBindings = (
  condition: Condition,
  bindings: Record<string, RuleValue>,
): Condition =>
  mapCondition(condition, {
    rewrite: (node) => {
      if (typeof node.bind !== 'string' || !Object.hasOwn(bindings, node.bind)) return node;
      const { bind, ...rest } = node;
      const bound = bindings[bind as string];
      return { ...rest, value: bound === undefined ? null : bound };
    },
  });
