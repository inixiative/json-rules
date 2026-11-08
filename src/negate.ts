import { resolveExpr } from './amount';
import { isDateExpr } from './dateExpr';
import { hasNoOperand } from './field';
import { ArrayOperator } from './operator';
import {
  COMPLEMENT_DATE_OPERATORS,
  COMPLEMENT_OPERATORS,
  NEGATED_OPERATORS,
  OPPOSITE_OPERATORS,
} from './operatorCatalog';
import { own } from './own';
import { parseScopeRef, readPath, type Scopes } from './scope';
import { allOf, anyOf, conditionShape, leafSources } from './traverse';
import type { Condition, Rule, RuleValue, ValueSourceFields } from './types';
import { hasPath, matchSource, type ReadSource, readBinding } from './valueSource';

type Node = Record<string, unknown>;
type Source = ValueSourceFields<unknown>;

/** A leaf `depth` relation hops into the negation, with its operands read; `null` when one reads
 *  nothing (the leaf is then false); UNREAD when they are read per item, where no settle is. */
export type Settle = (leaf: Node, depth: number) => Node | null | typeof UNREAD;

/** A leaf whose operands a settle can't read: they are read per item of a relation. */
export const UNREAD = Symbol('unread');

const absent = (field: unknown): Condition => ({ field, operator: 'notExists' }) as Condition;

const WINDOW_KEYS = ['filter', 'orderBy', 'take', 'skip'];

// Whether an aggregate has a number, over the same rows, window and coercion: an average over no
// values is NULL, as a field with no value is.
const presence = (leaf: Node, operator: 'exists' | 'notExists'): Condition =>
  ({
    field: leaf.field,
    aggregate: leaf.aggregate,
    ...Object.fromEntries(
      ['condition', 'coerceType', ...WINDOW_KEYS]
        .filter((key) => leaf[key] !== undefined)
        .map((key) => [key, leaf[key]]),
    ),
    operator,
  }) as Condition;

const negateLeaf = (node: Node, settle: Settle, depth: number): Condition => {
  const leaf = settle(node, depth);
  // Read per item: check()'s own if / then is the complement there.
  if (leaf === UNREAD) return { if: node as Condition, then: false };
  // Nothing to compare against: a positive comparison is false everywhere, so its complement
  // holds everywhere; a negation still keeps a NULL field, so its complement is a present one.
  if (leaf === null) {
    const op = (node.operator ?? node.dateOperator) as string;
    if (!NEGATED_OPERATORS.includes(op)) return true;
    return 'aggregate' in node
      ? presence(node, 'exists')
      : ({ field: node.field, operator: 'exists' } as Condition);
  }
  if ('aggregate' in leaf) {
    const flip = own(COMPLEMENT_OPERATORS, leaf.operator as string);
    if (flip) return { ...leaf, operator: flip } as Condition;
    const opposite = { ...leaf, operator: own(OPPOSITE_OPERATORS, leaf.operator as string) };
    // A sum is never NULL; an average over no values is, and the opposite comparison is false there.
    return (leaf.aggregate as { mode?: unknown }).mode === 'avg'
      ? anyOf([opposite as Condition, presence(leaf, 'notExists')])
      : (opposite as Condition);
  }
  if (typeof leaf.dateOperator === 'string') {
    const flip = own(COMPLEMENT_DATE_OPERATORS, leaf.dateOperator);
    if (flip) return { ...leaf, dateOperator: flip } as Condition;
    return anyOf([
      { ...leaf, dateOperator: own(OPPOSITE_OPERATORS, leaf.dateOperator) } as Condition,
      absent(leaf.field),
    ]);
  }
  if (typeof leaf.arrayOperator === 'string') {
    const count = leaf.count as number;
    switch (leaf.arrayOperator) {
      case ArrayOperator.any:
        return { ...leaf, arrayOperator: ArrayOperator.none } as Condition;
      case ArrayOperator.none:
        return { ...leaf, arrayOperator: ArrayOperator.any } as Condition;
      case ArrayOperator.all:
        return {
          ...leaf,
          arrayOperator: ArrayOperator.any,
          condition: negate(leaf.condition as Condition, settle, depth + 1),
        } as Condition;
      case ArrayOperator.empty:
        return { ...leaf, arrayOperator: ArrayOperator.notEmpty } as Condition;
      case ArrayOperator.notEmpty:
        return { ...leaf, arrayOperator: ArrayOperator.empty } as Condition;
      case ArrayOperator.atLeast:
        return count <= 0
          ? false
          : ({ ...leaf, arrayOperator: ArrayOperator.atMost, count: count - 1 } as Condition);
      case ArrayOperator.atMost:
        return { ...leaf, arrayOperator: ArrayOperator.atLeast, count: count + 1 } as Condition;
      case ArrayOperator.exactly:
        return anyOf([
          ...(count > 0
            ? [{ ...leaf, arrayOperator: ArrayOperator.atMost, count: count - 1 } as Condition]
            : []),
          { ...leaf, arrayOperator: ArrayOperator.atLeast, count: count + 1 } as Condition,
        ]);
    }
  }
  const flip = own(COMPLEMENT_OPERATORS, leaf.operator as string);
  if (flip) return { ...leaf, operator: flip } as Condition;
  // Against a column of the same row, the comparison is false where either side is NULL.
  const column =
    typeof leaf.path === 'string' && leaf.path !== ''
      ? (parseScopeRef(leaf.path) ?? { depth: 1, path: leaf.path })
      : null;
  return anyOf([
    { ...leaf, operator: own(OPPOSITE_OPERATORS, leaf.operator as string) } as Condition,
    absent(leaf.field),
    ...(column && column.depth === 1 ? [absent(column.path)] : []),
  ]);
};

/**
 * The condition that holds exactly where `condition` doesn't, under check(). A rail that can't
 * negate a predicate whose NULL means false (Prisma's NOT drops the row) compiles the complement
 * instead. `settle` reads a leaf's operands the way the rail will — a leaf whose operand reads
 * nothing is false, so its complement is true. `depth`: the relation hops `condition` sits below
 * where the settle reads.
 */
export const negate = (
  condition: Condition,
  settle: Settle = (leaf) => leaf,
  depth = 0,
): Condition => {
  if (typeof condition === 'boolean') return !condition;
  const node = condition as Node;
  const recurse = (c: Condition) => negate(c, settle, depth);
  if (Array.isArray(node.all)) return anyOf((node.all as Condition[]).map(recurse));
  if (Array.isArray(node.any)) return allOf((node.any as Condition[]).map(recurse));
  if ('if' in node) {
    const holds = allOf([node.if as Condition, recurse(node.then as Condition)]);
    if (node.else === undefined) return holds;
    return {
      any: [holds, allOf([recurse(node.if as Condition), recurse(node.else as Condition)])],
    };
  }
  return negateLeaf(node, settle, depth);
};

/** A literal operand that reads nothing: null, or a range missing an end. */
export const settleLiteral = (leaf: Node): Node | null =>
  ['field', 'aggregate'].includes(conditionShape(leaf) as string) &&
  leaf.value !== undefined &&
  hasNoOperand(leaf as Rule, leaf.value)
    ? null
    : leaf;

/** How a settle reads one value source of a leaf `depth` hops in: its value, or UNREAD. */
export type ReadSourceAt = (source: Source, depth: number) => unknown;

// A date expression whose unit amounts read nothing places no date.
const placesNothing = (expr: unknown, read: ReadSource): boolean =>
  isDateExpr(expr) && resolveExpr(expr, read) === null;

/** The one settle: each leaf's comparison value and offset read by `read` into literals, and the
 *  leaf null where one reads nothing — a missing offset, a null operand, a range missing an end, a
 *  date amount. */
export const settleWith =
  (read: ReadSourceAt): Settle =>
  (leaf, depth) => {
    const comparison = typeof leaf.operator === 'string' || typeof leaf.dateOperator === 'string';
    const sourced =
      leaf.value !== undefined || hasPath(leaf as Source) || typeof leaf.bind === 'string';
    if (!comparison || !sourced) return leaf;
    if (leafSources(leaf).some(({ source }) => read(source, depth) === UNREAD)) return UNREAD;
    const readHere: ReadSource = (source) => read(source, depth);
    const value = read(leaf, depth);
    const offset = leaf.offset === undefined ? undefined : read(leaf.offset as Source, depth);
    if (leaf.offset !== undefined && (offset === null || offset === undefined)) return null;
    const { path: _path, bind: _bind, bindOptional: _optional, ...rest } = leaf;
    const literal = {
      ...rest,
      value,
      ...(leaf.offset !== undefined && { offset: { value: offset } }),
    };
    if (typeof leaf.dateOperator !== 'string') return settleLiteral(literal);
    // A date range with a missing end reads nothing, as a field range does.
    return value === null ||
      value === undefined ||
      hasNoOperand({ operator: leaf.dateOperator } as Rule, value) ||
      [value, offset].flat().some((expr) => placesNothing(expr, readHere))
      ? null
      : literal;
  };

/** check()'s settle at one row: a literal as itself, a bind from `bindings`, a path from `scopes`
 *  (the root row first, as check() holds them); a `$`-path that reads an item of a relation the
 *  negation entered is UNREAD. */
export const settleIn = ({
  bindings,
  scopes,
}: {
  bindings?: Record<string, RuleValue>;
  scopes: Scopes;
}): Settle =>
  settleWith((source, depth) =>
    matchSource<unknown>(source, {
      value: (value) => value,
      bind: (name, optional) => readBinding(name, optional, bindings),
      path: (ref) => {
        const scoped = parseScopeRef(ref);
        if (!scoped) return readPath(ref, scopes) ?? null;
        if (scoped.depth <= depth) return UNREAD;
        return readPath(`${'$'.repeat(scoped.depth - depth)}.${scoped.path}`, scopes) ?? null;
      },
    }),
  );
