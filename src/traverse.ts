import type { Condition } from './types';

export type ConditionNode = Record<string, unknown>;

export const isObjCondition = (c: Condition): c is Exclude<Condition, boolean> =>
  typeof c === 'object' && c !== null;

/**
 * Array rules (`arrayOperator`) and aggregate rules (`aggregate`) are the two nodes that
 * descend into a relation's rows: their `field` names the relation, and both `condition`
 * and the windowing `filter` are evaluated against a row, not against the parent model.
 */
export const isRelationNode = (node: ConditionNode): boolean =>
  'arrayOperator' in node || 'aggregate' in node;

/**
 * Child-state derivation for `condition` / `filter` descent. Return the state those
 * children see, or null to prune the descent. Omitted = state passes through unchanged.
 */
type Descend<S> = (node: ConditionNode, state: S) => S | null;

/**
 * THE structural walk over a condition tree — every read that enumerates nodes goes
 * through here (`requiredBindings`, `referencedFieldValues`, …). The grammar's child
 * slots are listed exactly once: `all` / `any`, `if` / `then` / `else`, and a node's
 * `condition` + windowing `filter`. A new node type added here is picked up by every
 * consumer at once; a walk added elsewhere goes blind the day the grammar grows.
 */
export const visitCondition = <S>(
  condition: Condition,
  state: S,
  opts: { enter: (node: ConditionNode, state: S) => void; descend?: Descend<S> },
): void => {
  if (!isObjCondition(condition)) return;
  const node = condition as ConditionNode;
  opts.enter(node, state);

  if (Array.isArray(node.all))
    for (const child of node.all as Condition[]) visitCondition(child, state, opts);
  if (Array.isArray(node.any))
    for (const child of node.any as Condition[]) visitCondition(child, state, opts);
  if ('if' in node) {
    visitCondition(node.if as Condition, state, opts);
    visitCondition(node.then as Condition, state, opts);
    if (node.else !== undefined) visitCondition(node.else as Condition, state, opts);
  }
  if (node.condition !== undefined || node.filter !== undefined) {
    const inner = opts.descend ? opts.descend(node, state) : state;
    if (inner === null) return;
    if (node.condition !== undefined) visitCondition(node.condition as Condition, inner, opts);
    if (node.filter !== undefined) visitCondition(node.filter as Condition, inner, opts);
  }
};

/**
 * The rewrite twin of `visitCondition` — every structure-preserving transform goes
 * through here (`resolveBindings`, `transformFieldValues`, …). Pre-order: `rewrite`
 * receives a shallow clone of each node before its children are rebuilt, so a
 * substitution's own children are still walked. Never mutates the input.
 */
export const mapCondition = <S>(
  condition: Condition,
  state: S,
  opts: { rewrite: (node: ConditionNode, state: S) => ConditionNode; descend?: Descend<S> },
): Condition => {
  if (!isObjCondition(condition)) return condition;
  const node = opts.rewrite({ ...(condition as ConditionNode) }, state);

  if (Array.isArray(node.all))
    node.all = (node.all as Condition[]).map((child) => mapCondition(child, state, opts));
  if (Array.isArray(node.any))
    node.any = (node.any as Condition[]).map((child) => mapCondition(child, state, opts));
  if ('if' in node) {
    node.if = mapCondition(node.if as Condition, state, opts);
    node.then = mapCondition(node.then as Condition, state, opts);
    if (node.else !== undefined) node.else = mapCondition(node.else as Condition, state, opts);
  }
  if (node.condition !== undefined || node.filter !== undefined) {
    const inner = opts.descend ? opts.descend(node, state) : state;
    if (inner !== null) {
      if (node.condition !== undefined)
        node.condition = mapCondition(node.condition as Condition, inner, opts);
      if (node.filter !== undefined)
        node.filter = mapCondition(node.filter as Condition, inner, opts);
    }
  }
  return node as Condition;
};
