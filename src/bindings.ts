import {
  type ConditionNode,
  leafSources,
  mapCondition,
  mapLeafSources,
  visitCondition,
} from './traverse';
import type { Condition, RuleValue, ValueSourceOf } from './types';

export { readBinding } from './valueSource';

// Every `{ bind }` on a leaf: its comparison value, its offset, its unit amounts.
const bindTokens = (node: ConditionNode): { bind: string; bindOptional?: boolean }[] =>
  leafSources(node).flatMap(({ source }) =>
    typeof source.bind === 'string'
      ? [{ bind: source.bind, bindOptional: source.bindOptional }]
      : [],
  );

/** Names of every `{ bind }` token in the tree, optional or not — what a lens declares. */
export const bindingNames = (condition: Condition): Set<string> => {
  const names = new Set<string>();
  visitCondition(condition, {
    enter: (node) => {
      for (const token of bindTokens(node)) names.add(token.bind);
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
      for (const token of bindTokens(node)) if (token.bindOptional !== true) names.add(token.bind);
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
): Condition => {
  // A covered `{ bind, bindOptional }` source becomes `{ value }`; an uncovered one stays.
  const resolve = (source: ValueSourceOf<unknown>): ValueSourceOf<unknown> => {
    if (typeof source.bind !== 'string' || !Object.hasOwn(bindings, source.bind)) return source;
    const { bind, bindOptional: _optional, ...rest } = source;
    const bound = bindings[bind];
    return { ...rest, value: bound === undefined ? null : bound } as ValueSourceOf<unknown>;
  };
  return mapCondition(condition, { rewrite: (node) => mapLeafSources(node, resolve) });
};
