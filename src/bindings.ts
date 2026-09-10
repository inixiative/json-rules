import { type ConditionNode, mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

const isBindLeaf = (node: ConditionNode): node is ConditionNode & { bind: string } =>
  typeof node.bind === 'string';

/** Names of every `{ bind }` token in the tree, optional or not — what a lens declares. */
export const bindingNames = (condition: Condition): Set<string> => {
  const names = new Set<string>();
  visitCondition(condition, {
    enter: (node) => {
      if (isBindLeaf(node)) names.add(node.bind);
    },
  });
  return names;
};

/**
 * Names a bindings map must cover: every `{ bind }` token not marked `bindOptional`. A
 * name that is optional at one leaf and required at another is required. An optional
 * name left unsupplied evaluates and compiles as `null`.
 */
export const requiredBindings = (condition: Condition): Set<string> => {
  const names = new Set<string>();
  visitCondition(condition, {
    enter: (node) => {
      if (isBindLeaf(node) && node.bindOptional !== true) names.add(node.bind);
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
      const { bind, bindOptional: _optional, ...rest } = node;
      const bound = bindings[bind as string];
      return { ...rest, value: bound === undefined ? null : bound };
    },
  });
