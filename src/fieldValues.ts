import type { Condition, RuleValue } from './types';

type ObjCondition = Exclude<Condition, boolean>;
type Node = Record<string, unknown>;

const isObjCondition = (c: Condition): c is ObjCondition => typeof c === 'object' && c !== null;

/**
 * Array rules (`arrayOperator`) and aggregate rules (`aggregate`) are the two nodes that
 * descend into a relation's rows: their `field` names the relation, and both `condition`
 * and the windowing `filter` are evaluated against a row, not against the parent model.
 */
const isRelationNode = (node: Node): boolean => 'arrayOperator' in node || 'aggregate' in node;

/** `path` with `prefix`'s segments removed, or null when `prefix` isn't a segment prefix. */
const stripPrefix = (path: string, prefix: string): string | null => {
  if (path === prefix) return '';
  return path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : null;
};

/**
 * The one walk that resolves a dotted path against a condition tree, descending relation
 * by relation and consuming the segments each relation's `field` names. Both spellings of
 * the same reference arrive here: nested (`{ field: 'orders', arrayOperator, condition:
 * { field: 'sku' } }`) and dotted (`{ field: 'orders.sku' }`).
 *
 * `all` / `any` / `if-then-else` consume no segments. A relation whose `field` is absent
 * (a root array over primitives) consumes none either and is walked THROUGH, so a matching
 * leaf can never hide behind it — the callers are gates, and a missed reference is the
 * dangerous direction.
 */
const walkFieldValues = (condition: Condition, path: string, visit: (node: Node) => void): void => {
  if (!isObjCondition(condition)) return;
  const node = condition as Node;

  if (Array.isArray(node.all))
    for (const child of node.all as Condition[]) walkFieldValues(child, path, visit);
  if (Array.isArray(node.any))
    for (const child of node.any as Condition[]) walkFieldValues(child, path, visit);
  if ('if' in node) {
    walkFieldValues(node.if as Condition, path, visit);
    walkFieldValues(node.then as Condition, path, visit);
    if (node.else !== undefined) walkFieldValues(node.else as Condition, path, visit);
  }

  const field = typeof node.field === 'string' ? node.field : undefined;

  if (isRelationNode(node)) {
    const inner = field === undefined ? path : stripPrefix(path, field);
    if (inner === null) return;
    if (node.condition !== undefined) walkFieldValues(node.condition as Condition, inner, visit);
    if (node.filter !== undefined) walkFieldValues(node.filter as Condition, inner, visit);
    return;
  }

  if (field !== undefined && field === path) visit(node);
};

export type FieldValueRefs = {
  /** Every literal a matching leaf compares against, list operators flattened. */
  values: Set<RuleValue>;
  /**
   * A matching leaf sourced its value from `path` / `bind` rather than a literal, so the
   * set is incomplete by construction. Gates that must fail closed read this instead of
   * treating "no literals" as "no reference".
   */
  dynamic: boolean;
};

/**
 * The values a condition tree compares a given field against — the read half of the pair
 * (`transformFieldValues` is the write half), and the engine-owned answer to "which X does
 * this rule mention".
 *
 * `path` is dotted from the tree's root model (`'fanUserGroups.group.uuid'`). Values are
 * collected regardless of operator and quantifier: `equals` and `notEquals` carry a scalar,
 * `in` / `notIn` a list, `between` a tuple, and a `none` relation mentions its value just as
 * much as an `any` one does. An aggregate node's own comparison value belongs to the
 * aggregate, not to the relation it names, so it is never collected as one.
 */
export const referencedFieldValues = (condition: Condition, path: string): FieldValueRefs => {
  const values = new Set<RuleValue>();
  let dynamic = false;

  walkFieldValues(condition, path, (node) => {
    if (typeof node.path === 'string' || typeof node.bind === 'string') {
      dynamic = true;
      return;
    }
    if (!('value' in node)) return;
    const value = node.value as RuleValue;
    for (const entry of Array.isArray(value) ? value : [value]) values.add(entry);
  });

  return { values, dynamic };
};

/**
 * Rewrite every literal a given field is compared against, leaving the tree's shape and
 * every other leaf untouched. The remap primitive for callers that clone or re-key the
 * data a rule names (a sandbox clone re-pointing ids, a merge re-pointing a renamed key).
 *
 * Same path semantics as `referencedFieldValues`. `path` / `bind` leaves are left alone —
 * there is no literal to rewrite, and inventing one would silently change the rule.
 * Does not mutate the input.
 */
export const transformFieldValues = (
  condition: Condition,
  path: string,
  fn: (value: RuleValue) => RuleValue,
): Condition => {
  if (!isObjCondition(condition)) return condition;
  const node: Node = { ...(condition as Node) };

  if (Array.isArray(node.all))
    node.all = (node.all as Condition[]).map((c) => transformFieldValues(c, path, fn));
  if (Array.isArray(node.any))
    node.any = (node.any as Condition[]).map((c) => transformFieldValues(c, path, fn));
  if ('if' in node) {
    node.if = transformFieldValues(node.if as Condition, path, fn);
    node.then = transformFieldValues(node.then as Condition, path, fn);
    if (node.else !== undefined) node.else = transformFieldValues(node.else as Condition, path, fn);
  }

  const field = typeof node.field === 'string' ? node.field : undefined;

  if (isRelationNode(node)) {
    const inner = field === undefined ? path : stripPrefix(path, field);
    if (inner === null) return node as Condition;
    if (node.condition !== undefined)
      node.condition = transformFieldValues(node.condition as Condition, inner, fn);
    if (node.filter !== undefined)
      node.filter = transformFieldValues(node.filter as Condition, inner, fn);
    return node as Condition;
  }

  if (field === path && 'value' in node && node.path === undefined && node.bind === undefined) {
    const value = node.value as RuleValue;
    node.value = Array.isArray(value) ? value.map(fn) : fn(value);
  }

  return node as Condition;
};
