import { isPlainObject } from 'lodash-es';
import { isCalendarUnit } from './amount';
import { isDateExpr, isRollingExpr } from './dateExpr';
import type { Condition, ValueSourceOf } from './types';
import { isValueSource } from './valueSource';

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

/** How a slot's value is used: the comparison value, a number, a whole number, a date shift. */
export type SourceRole = 'value' | 'number' | 'whole' | 'shift';

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
  if (!isDateExpr(expr) || !isRollingExpr(expr)) return expr;
  return 'ago' in expr ? { ago: mapUnits(expr.ago, fn) } : { ahead: mapUnits(expr.ahead, fn) };
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

export type LeafSource = { source: ValueSourceOf<unknown>; role: SourceRole };

/** Every value source on a leaf, with how its value is used. */
export const leafSources = (node: Record<string, unknown>): LeafSource[] => {
  const found: LeafSource[] = [];
  mapLeafSources(node, (source, role) => {
    found.push({ source, role });
    return source;
  });
  return found;
};

export type ValueRef = { ref: string; role: SourceRole };

/** Every path a leaf reads on its value side, with how it is read. */
export const valueRefRoles = (node: Record<string, unknown>): ValueRef[] =>
  leafSources(node).flatMap(({ source, role }) =>
    typeof source.path === 'string' && source.path !== '' ? [{ ref: source.path, role }] : [],
  );

/** Every path a leaf reads on its value side. */
export const valueRefs = (node: Record<string, unknown>): string[] =>
  valueRefRoles(node).map((r) => r.ref);
