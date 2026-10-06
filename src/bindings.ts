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
 * The value of one `{ bind }` token at evaluation. Key presence is the contract: an
 * unsupplied binding is a caller bug (a forgotten scope must never silently run) unless the
 * rule marks it `bindOptional`, which reads as null. A supplied-but-undefined binding is null.
 */
export const readBinding = (
  name: string,
  optional: boolean | undefined,
  bindings: Record<string, RuleValue> | undefined,
): RuleValue => {
  if (!bindings || !Object.hasOwn(bindings, name)) {
    if (optional === true) return null;
    throw new Error(`Missing binding for "${name}"`);
  }
  const bound = bindings[name];
  return bound === undefined ? null : bound;
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
