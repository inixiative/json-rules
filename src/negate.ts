import { hasNoOperand } from './field';
import { ArrayOperator } from './operator';
import {
  COMPLEMENT_DATE_OPERATORS,
  COMPLEMENT_OPERATORS,
  NEGATED_OPERATORS,
  OPPOSITE_OPERATORS,
} from './operatorCatalog';
import { anyOf } from './traverse';
import type { Condition, Rule } from './types';

type Node = Record<string, unknown>;

/** A leaf with its operands read, or `null` when one reads nothing (the leaf is then false). */
export type Settle = (leaf: Node) => Node | null;

const absent = (field: unknown): Condition => ({ field, operator: 'notExists' }) as Condition;

const negateLeaf = (node: Node, settle: Settle): Condition => {
  const leaf = settle(node);
  // Nothing to compare against: a positive comparison is false everywhere, so its complement
  // holds everywhere; a negation still keeps a NULL field, so its complement is a present one.
  if (leaf === null) {
    const op = (node.operator ?? node.dateOperator) as string;
    return NEGATED_OPERATORS.includes(op)
      ? ({ field: node.field, operator: 'exists' } as Condition)
      : true;
  }
  if ('aggregate' in leaf) {
    const flip = COMPLEMENT_OPERATORS[leaf.operator as string];
    if (flip) return { ...leaf, operator: flip } as Condition;
    return { ...leaf, operator: OPPOSITE_OPERATORS[leaf.operator as string] } as Condition;
  }
  if (typeof leaf.dateOperator === 'string') {
    const flip = COMPLEMENT_DATE_OPERATORS[leaf.dateOperator];
    if (flip) return { ...leaf, dateOperator: flip } as Condition;
    return anyOf([
      { ...leaf, dateOperator: OPPOSITE_OPERATORS[leaf.dateOperator] } as Condition,
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
          condition: negate(leaf.condition as Condition, settle),
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
  const flip = COMPLEMENT_OPERATORS[leaf.operator as string];
  if (flip) return { ...leaf, operator: flip } as Condition;
  return anyOf([
    { ...leaf, operator: OPPOSITE_OPERATORS[leaf.operator as string] } as Condition,
    absent(leaf.field),
  ]);
};

/**
 * The condition that holds exactly where `condition` doesn't, under check(). A rail that can't
 * negate a predicate whose NULL means false (Prisma's NOT drops the row) compiles the complement
 * instead. `settle` reads a leaf's operands the way the rail will — a leaf whose operand reads
 * nothing is false, so its complement is true.
 */
export const negate = (condition: Condition, settle: Settle = (leaf) => leaf): Condition => {
  if (typeof condition === 'boolean') return !condition;
  const node = condition as Node;
  if (Array.isArray(node.all))
    return { any: (node.all as Condition[]).map((c) => negate(c, settle)) };
  if (Array.isArray(node.any))
    return { all: (node.any as Condition[]).map((c) => negate(c, settle)) };
  if ('if' in node) {
    const holds = { all: [node.if as Condition, negate(node.then as Condition, settle)] };
    if (node.else === undefined) return holds;
    return {
      any: [
        holds,
        { all: [negate(node.if as Condition, settle), negate(node.else as Condition, settle)] },
      ],
    };
  }
  return negateLeaf(node, settle);
};

/** check()'s settle: a leaf's literal operand reads nothing when it's null or a range misses an
 *  end — the compilers read paths and offsets into literals before negating. */
export const settleLiteral: Settle = (leaf) =>
  typeof leaf.operator === 'string' &&
  !('aggregate' in leaf) &&
  leaf.value !== undefined &&
  hasNoOperand(leaf as Rule, leaf.value)
    ? null
    : leaf;
