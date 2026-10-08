import { isPlainObject } from 'lodash-es';
import { isDateExpr, rollingExpr, rollingShift } from './dateExpr';
import { isCalendarUnit } from './operatorCatalog';
import type { Condition, RelativeUnits, ValueSourceOf } from './types';
import { hasPath, isValueSource } from './valueSource';

export type ConditionNode = Record<string, unknown>;

const isObjCondition = (c: Condition): c is Exclude<Condition, boolean> =>
  typeof c === 'object' && c !== null;

// An implication is any of its three keys, as conditionShape reads it.
const isIfNode = (node: ConditionNode): boolean => 'if' in node || 'then' in node || 'else' in node;

export const isRelationNode = (node: ConditionNode): boolean =>
  'arrayOperator' in node || 'aggregate' in node;

// The one structural walk over a condition tree — the grammar's child slots are listed
// here and nowhere else. A node's logical children (`all` / `any` / `if`…) sit in its scope;
// its `condition` / `filter` sit in the scope `below` returns for it (the same by default),
// and `false` stops the walk there. A scope is whatever the walk tracks: a relation target,
// a stack of them, a model.
type Below<S> = (node: ConditionNode, scope: S) => S | false;

type Slot = { key: string; index?: number; child: Condition; nested: boolean };

const childSlots = (node: ConditionNode): Slot[] => [
  ...(['all', 'any'] as const).flatMap((key) =>
    Array.isArray(node[key])
      ? (node[key] as Condition[]).map((child, index) => ({ key, index, child, nested: false }))
      : [],
  ),
  ...(isIfNode(node)
    ? (['if', 'then', 'else'] as const).flatMap((key) =>
        node[key] !== undefined ? [{ key, child: node[key] as Condition, nested: false }] : [],
      )
    : []),
  ...(['condition', 'filter'] as const).flatMap((key) =>
    node[key] !== undefined ? [{ key, child: node[key] as Condition, nested: true }] : [],
  ),
];

export const isLogicalNode = (node: ConditionNode): boolean =>
  'all' in node || 'any' in node || isIfNode(node);

/** Visits every node with the scope it sits in. `enter` returns the scope for the node's
 *  `condition` / `filter` (nothing for the same, `false` to stop there). */
export const visitCondition = <S = undefined>(
  condition: Condition,
  enter: (node: ConditionNode, scope: S) => S | false | undefined,
  scope?: S,
): void => {
  if (!isObjCondition(condition)) return;
  const node = condition as ConditionNode;
  const below = enter(node, scope as S);
  const inner = below === undefined ? scope : below;
  for (const { child, nested } of childSlots(node)) {
    if (!nested) visitCondition(child, enter, scope);
    else if (inner !== false) visitCondition(child, enter, inner);
  }
};

/** True when `test` holds for any node; `below` scopes nested conditions as in visitCondition. */
export const someCondition = <S = undefined>(
  condition: Condition,
  test: (node: ConditionNode, scope: S) => boolean,
  below?: Below<S>,
  scope?: S,
): boolean => {
  let found = false;
  visitCondition<S>(
    condition,
    (node, at) => {
      if (!found && test(node, at)) found = true;
      return found ? false : below?.(node, at);
    },
    scope,
  );
  return found;
};

// Rewrite twin. `rewrite` sees a shallow clone before its children rebuild (pre-order, so a
// substitution's own children are still walked); `after` sees it once they have (to wrap it
// without walking the wrapper). Never mutates the input, and returns it when nothing changed.
export const mapCondition = <S = undefined>(
  condition: Condition,
  opts: {
    rewrite?: (node: ConditionNode, scope: S) => ConditionNode;
    after?: (node: ConditionNode, scope: S) => Condition;
    below?: Below<S>;
  },
  scope?: S,
): Condition => {
  if (!isObjCondition(condition)) return condition;
  const at = scope as S;
  const clone = { ...(condition as ConditionNode) };
  const node = opts.rewrite ? opts.rewrite(clone, at) : clone;
  const slots = childSlots(node);
  const inner = slots.some((slot) => slot.nested) && opts.below ? opts.below(node, at) : at;
  for (const key of ['all', 'any'])
    if (Array.isArray(node[key])) node[key] = [...(node[key] as [])];
  for (const { key, index, child, nested } of slots) {
    if (nested && inner === false) continue;
    const mapped = mapCondition(child, opts, nested ? (inner as S) : at);
    if (index === undefined) node[key] = mapped;
    else (node[key] as Condition[])[index] = mapped;
  }
  const result = opts.after ? opts.after(node, at) : (node as Condition);
  return result === node && sameNode(node, condition as ConditionNode) ? condition : result;
};

// Whether a rebuilt node holds exactly what the original did, so an untouched tree comes back
// as the same object.
const sameNode = (node: ConditionNode, original: ConditionNode): boolean => {
  const keys = Object.keys(node);
  if (keys.length !== Object.keys(original).length) return false;
  return keys.every((key) => {
    const [a, b] = [node[key], original[key]];
    if (a === b) return true;
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => item === b[index])
    );
  });
};

/** How a slot's value is used: the comparison value, a number, a whole number, a date shift. */
type SourceRole = 'value' | 'number' | 'whole' | 'shift';

type MapSource = (source: ValueSourceOf<unknown>, role: SourceRole) => ValueSourceOf<unknown>;

const mapUnits = (units: unknown, fn: MapSource): unknown =>
  isPlainObject(units)
    ? Object.fromEntries(
        Object.entries(units as Record<string, unknown>).map(([unit, amount]) => [
          unit,
          isValueSource(amount) ? fn(amount, isCalendarUnit(unit) ? 'whole' : 'number') : amount,
        ]),
      )
    : units;

const mapExpr = (expr: unknown, fn: MapSource): unknown => {
  const rolling = isDateExpr(expr) ? rollingShift(expr) : null;
  return rolling ? rollingExpr(mapUnits(rolling[0], fn) as RelativeUnits, rolling[1]) : expr;
};

/**
 * A leaf's value-source slots, listed once: the leaf itself, its offset, and — on a date rule —
 * each unit amount in its value and its offset's value. `fn` rewrites each slot (identity to
 * list them). Non-mutating; a node with no slots comes back as is.
 */
export const mapLeafSources = <T extends Record<string, unknown>>(node: T, fn: MapSource): T => {
  const isDate = 'dateOperator' in node;
  if (!isDate && !('operator' in node)) return node;
  let out: Record<string, unknown> = node;
  if (isDate && node.value !== undefined) {
    const value = Array.isArray(node.value)
      ? node.value.map((v) => mapExpr(v, fn))
      : mapExpr(node.value, fn);
    out = { ...out, value };
  }
  if (isValueSource(node.offset)) {
    const offset = isDate
      ? {
          ...node.offset,
          ...(node.offset.value !== undefined && { value: mapExpr(node.offset.value, fn) }),
        }
      : node.offset;
    out = { ...out, offset: fn(offset as ValueSourceOf<unknown>, isDate ? 'shift' : 'number') };
  }
  if (isValueSource(out)) out = fn(out, 'value');
  return out as T;
};

type LeafSource = { source: ValueSourceOf<unknown>; role: SourceRole };

/** Every value source on a leaf, with how its value is used. */
export const leafSources = (node: Record<string, unknown>): LeafSource[] => {
  const found: LeafSource[] = [];
  mapLeafSources(node, (source, role) => {
    found.push({ source, role });
    return source;
  });
  return found;
};

type ValueRef = { ref: string; role: SourceRole };

/** Every path a leaf reads on its value side, with how it is read. */
export const valueRefRoles = (node: Record<string, unknown>): ValueRef[] =>
  leafSources(node).flatMap(({ source, role }) =>
    hasPath(source) ? [{ ref: source.path, role }] : [],
  );

/** Every path a leaf reads on its value side. */
export const valueRefs = (node: Record<string, unknown>): string[] =>
  valueRefRoles(node).map((r) => r.ref);

// The element fields a relation node orders or aggregates by — read per element, under the
// element's clamps.
export const elementRefs = (node: Record<string, unknown>): string[] => [
  ...(Array.isArray(node.orderBy)
    ? (node.orderBy as { field?: unknown }[]).flatMap((o) =>
        typeof o?.field === 'string' ? [o.field] : [],
      )
    : []),
  ...(typeof (node.aggregate as { field?: unknown })?.field === 'string'
    ? [(node.aggregate as { field: string }).field]
    : []),
];

export type ConditionShape = 'all' | 'any' | 'if' | 'field' | 'aggregate' | 'array' | 'date';

/** What a condition node is — exactly one of the grammar's node kinds — or null when its keys
 *  name more than one (a node every rail would read differently). */
export const conditionShape = (node: Record<string, unknown>): ConditionShape | null => {
  const shapes = new Set<ConditionShape>();
  if ('all' in node) shapes.add('all');
  if ('any' in node) shapes.add('any');
  if (isIfNode(node)) shapes.add('if');
  if ('arrayOperator' in node) shapes.add('array');
  if ('dateOperator' in node) shapes.add('date');
  if ('aggregate' in node) shapes.add('aggregate');
  else if ('operator' in node) shapes.add('field');
  return shapes.size === 1 ? [...shapes][0] : null;
};

/** Conditions AND-ed together: `true` for none, the condition itself for one. */
export const allOf = (conditions: readonly Condition[]): Condition =>
  conditions.length === 0
    ? true
    : conditions.length === 1
      ? conditions[0]
      : { all: [...conditions] };

/** allOf's inverse: a condition's top-level conjuncts, nested `all` nodes flattened. */
export const conjuncts = (condition: Condition): Condition[] =>
  typeof condition === 'object' && 'all' in condition && Array.isArray(condition.all)
    ? condition.all.flatMap(conjuncts)
    : [condition];

/** Conditions OR-ed together: `false` for none, the condition itself for one. */
export const anyOf = (conditions: readonly Condition[]): Condition =>
  conditions.length === 0
    ? false
    : conditions.length === 1
      ? conditions[0]
      : { any: [...conditions] };
