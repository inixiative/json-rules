import {
  type ConditionNode,
  leafSources,
  mapCondition,
  mapLeafSources,
  visitCondition,
} from './traverse';
import type { Condition, RuleValue, ValueSourceOf } from './types';

import { readBinding } from './valueSource';

// Every `{ bind }` on a leaf: its comparison value, its offset, its unit amounts.
type BindSource = Extract<ValueSourceOf<unknown>, { bind: string }>;
const bindTokens = (node: ConditionNode): BindSource[] =>
  leafSources(node).flatMap(({ source }) =>
    typeof source.bind === 'string' ? [source as BindSource] : [],
  );

/** `required`: leave out the names an optional bind (`bindOptional`) may go unsupplied. */
export type ListBindingsOptions = { required?: boolean };

/**
 * The bind names a rule reads, sorted. With `required`, only those a bindings map must cover —
 * not `bindOptional` (unsupplied, it reads null); a name optional at one leaf and required at
 * another is required.
 */
export const listBindings = (
  condition: Condition,
  { required = false }: ListBindingsOptions = {},
): string[] => {
  const names = new Set<string>();
  visitCondition(condition, (node) => {
    for (const token of bindTokens(node))
      if (!required || token.bindOptional !== true) names.add(token.bind);
  });
  return [...names].sort();
};

/**
 * Substitute covered binds with their values; uncovered tokens stay in place (partial
 * resolution). A supplied-but-undefined binding becomes null to stay serializable.
 * Non-mutating.
 */
export const bindRule = (condition: Condition, bindings: Record<string, RuleValue>): Condition => {
  // A covered `{ bind, bindOptional }` source becomes `{ value }`; an uncovered one stays.
  const resolve = (source: ValueSourceOf<unknown>): ValueSourceOf<unknown> => {
    if (typeof source.bind !== 'string' || !Object.hasOwn(bindings, source.bind)) return source;
    const { bind, bindOptional: _optional, ...rest } = source;
    return { ...rest, value: readBinding(bind, true, bindings) } as ValueSourceOf<unknown>;
  };
  // A second pass resolves binds a substituted value brought with it (a bound `{ ago }` whose
  // amount is itself a `{ bind }`).
  return mapCondition(condition, {
    rewrite: (node) => mapLeafSources(mapLeafSources(node, resolve), resolve),
  });
};
