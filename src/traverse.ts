import type { Condition } from './types';

export type ConditionNode = Record<string, unknown>;

export const isObjCondition = (c: Condition): c is Exclude<Condition, boolean> =>
  typeof c === 'object' && c !== null;

export const isRelationNode = (node: ConditionNode): boolean =>
  'arrayOperator' in node || 'aggregate' in node;

// The one structural walk over a condition tree — the grammar's child slots are listed
// here and nowhere else. `descend` gates `condition`/`filter` descent (default: walk).
export const visitCondition = (
  condition: Condition,
  opts: { enter: (node: ConditionNode) => void; descend?: (node: ConditionNode) => boolean },
): void => {
  if (!isObjCondition(condition)) return;
  const node = condition as ConditionNode;
  opts.enter(node);

  if (Array.isArray(node.all))
    for (const child of node.all as Condition[]) visitCondition(child, opts);
  if (Array.isArray(node.any))
    for (const child of node.any as Condition[]) visitCondition(child, opts);
  if ('if' in node) {
    visitCondition(node.if as Condition, opts);
    visitCondition(node.then as Condition, opts);
    if (node.else !== undefined) visitCondition(node.else as Condition, opts);
  }
  if (node.condition !== undefined || node.filter !== undefined) {
    if (opts.descend && !opts.descend(node)) return;
    if (node.condition !== undefined) visitCondition(node.condition as Condition, opts);
    if (node.filter !== undefined) visitCondition(node.filter as Condition, opts);
  }
};

// Rewrite twin: pre-order (`rewrite` sees a shallow clone before its children rebuild,
// so a substitution's own children are still walked). Never mutates the input.
export const mapCondition = (
  condition: Condition,
  opts: {
    rewrite: (node: ConditionNode) => ConditionNode;
    descend?: (node: ConditionNode) => boolean;
  },
): Condition => {
  if (!isObjCondition(condition)) return condition;
  const node = opts.rewrite({ ...(condition as ConditionNode) });

  if (Array.isArray(node.all))
    node.all = (node.all as Condition[]).map((child) => mapCondition(child, opts));
  if (Array.isArray(node.any))
    node.any = (node.any as Condition[]).map((child) => mapCondition(child, opts));
  if ('if' in node) {
    node.if = mapCondition(node.if as Condition, opts);
    node.then = mapCondition(node.then as Condition, opts);
    if (node.else !== undefined) node.else = mapCondition(node.else as Condition, opts);
  }
  if (node.condition !== undefined || node.filter !== undefined) {
    if (opts.descend && !opts.descend(node)) return node as Condition;
    if (node.condition !== undefined)
      node.condition = mapCondition(node.condition as Condition, opts);
    if (node.filter !== undefined) node.filter = mapCondition(node.filter as Condition, opts);
  }
  return node as Condition;
};
