import type { Condition, RuleValue } from './types';

type ObjCondition = Exclude<Condition, boolean>;

const isObjCondition = (c: Condition): c is ObjCondition => typeof c === 'object' && c !== null;

/**
 * Names of every `{ bind }` token reachable in a condition tree. The flat-set
 * shorthand a caller validates a bindings map against (`keys(bindings) ⊇ requiredBindings`).
 */
export const requiredBindings = (condition: Condition): Set<string> => {
  const names = new Set<string>();
  const walk = (c: Condition): void => {
    if (!isObjCondition(c)) return;
    const node = c as Record<string, unknown>;
    if (typeof node.bind === 'string') names.add(node.bind);
    if (Array.isArray(node.all)) (node.all as Condition[]).forEach(walk);
    if (Array.isArray(node.any)) (node.any as Condition[]).forEach(walk);
    if ('if' in node) {
      walk(node.if as Condition);
      walk(node.then as Condition);
      if (node.else !== undefined) walk(node.else as Condition);
    }
    if (node.condition) walk(node.condition as Condition);
  };
  walk(condition);
  return names;
};

/**
 * Replace each `{ bind }` token the map covers with its `{ value }`, leaving uncovered
 * tokens in place (partial / progressive resolution — `requiredBindings` shrinks). A node
 * may carry both its own value-bind and a nested condition (aggregate/array), so both are
 * handled. Does not mutate the input.
 */
export const resolveBindings = (
  condition: Condition,
  bindings: Record<string, RuleValue>,
): Condition => {
  if (!isObjCondition(condition)) return condition;
  let node = { ...(condition as Record<string, unknown>) };

  if (typeof node.bind === 'string' && node.bind in bindings) {
    const { bind, ...rest } = node;
    // A supplied binding (key present) resolves to its value; undefined → null so
    // the substituted condition stays clean serializable JSON. Absent keys are
    // left as tokens (partial resolution), never coerced.
    const bound = bindings[bind as string];
    node = { ...rest, value: bound === undefined ? null : bound };
  }

  if (Array.isArray(node.all))
    node.all = (node.all as Condition[]).map((c) => resolveBindings(c, bindings));
  if (Array.isArray(node.any))
    node.any = (node.any as Condition[]).map((c) => resolveBindings(c, bindings));
  if ('if' in node) {
    node.if = resolveBindings(node.if as Condition, bindings);
    node.then = resolveBindings(node.then as Condition, bindings);
    if (node.else !== undefined) node.else = resolveBindings(node.else as Condition, bindings);
  }
  if (node.condition) node.condition = resolveBindings(node.condition as Condition, bindings);

  return node as Condition;
};
