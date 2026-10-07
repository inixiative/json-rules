import { type ConditionNode, mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

// A leaf's bind tokens: its comparison value's, and its offset's — each `{ bind, bindOptional }`.
const bindTokens = (node: ConditionNode): { bind: string; bindOptional?: unknown }[] => {
  const tokens: { bind: string; bindOptional?: unknown }[] = [];
  if (typeof node.bind === 'string') tokens.push(node as { bind: string; bindOptional?: unknown });
  const offset = node.offset as { bind?: unknown; bindOptional?: unknown } | undefined;
  if (offset && typeof offset.bind === 'string')
    tokens.push(offset as { bind: string; bindOptional?: unknown });
  return tokens;
};

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
): Condition => {
  // A covered `{ bind, bindOptional }` source becomes `{ value }`; an uncovered one stays.
  const resolve = <T extends Record<string, unknown>>(source: T): T => {
    if (typeof source.bind !== 'string' || !Object.hasOwn(bindings, source.bind)) return source;
    const { bind, bindOptional: _optional, ...rest } = source;
    const bound = bindings[bind as string];
    return { ...rest, value: bound === undefined ? null : bound } as unknown as T;
  };
  return mapCondition(condition, {
    rewrite: (node) => {
      const resolved = resolve(node);
      const offset = resolved.offset as Record<string, unknown> | undefined;
      return offset && typeof offset === 'object'
        ? { ...resolved, offset: resolve(offset) }
        : resolved;
    },
  });
};
