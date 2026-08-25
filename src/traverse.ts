import type { Condition } from './types';

export type ConditionNode = Record<string, unknown>;

export const isObjCondition = (c: Condition): c is Exclude<Condition, boolean> =>
  typeof c === 'object' && c !== null;

export const isRelationNode = (node: ConditionNode): boolean =>
  'arrayOperator' in node || 'aggregate' in node;

type Descend<S> = (node: ConditionNode, state: S) => S | null;

// The one structural walk over a condition tree — the grammar's child slots are listed
// here and nowhere else. `descend` derives the state `condition`/`filter` children see;
// null prunes, omitted passes state through.
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

// Rewrite twin: pre-order (`rewrite` sees a shallow clone before its children rebuild,
// so a substitution's own children are still walked). Never mutates the input.
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
