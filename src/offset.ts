import { isDateExpr, rollingShift } from './dateExpr';
import { readNumber, toNumber } from './number';
import { DateOperator, Operator } from './operator';
import type { RelativeUnits } from './types';

// An offset moves a leaf's comparison value. It reads its own value source: a number on a field
// rule, a rolling `{ ago }` / `{ ahead }` on a date rule.

/** The operators an offset can shift: one point, or both ends of a range. */
export const OFFSET_OPERATORS: readonly string[] = [
  Operator.equals,
  Operator.notEquals,
  Operator.lessThan,
  Operator.lessThanEquals,
  Operator.greaterThan,
  Operator.greaterThanEquals,
  Operator.between,
  Operator.notBetween,
  DateOperator.before,
  DateOperator.after,
  DateOperator.onOrBefore,
  DateOperator.onOrAfter,
  DateOperator.notBefore,
  DateOperator.notAfter,
];

/** The negated operators an offset applies to: with nothing to compare against they still keep
 *  a null field (the 2.19.0 ruling). */
export const isNegatedOffsetOperator = (operator: string): boolean =>
  operator === Operator.notEquals || operator === Operator.notBetween;

/**
 * A comparison value moved by a numeric offset. A range moves at both ends, and a range
 * missing an end is null — nothing to compare against.
 */
export const addOffset = (value: unknown, offset: number): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const ends = value.map((item) => addOffset(item, offset));
    return ends.some((end) => end === null) ? null : ends;
  }
  const number = toNumber(value);
  if (typeof number !== 'number' || !Number.isFinite(number))
    throw new Error(`offset needs a numeric comparison value (got ${String(value)})`);
  return number + offset;
};

/** A numeric offset's amount, read from its source; null when it reads nothing. */
export const offsetAmount = (raw: unknown): number | null => readNumber(raw, 'an offset');

/** A date offset's rolling shift, read from its source; null when it reads nothing. */
export const offsetShift = (raw: unknown): [RelativeUnits, 1 | -1] | null => {
  if (raw === null || raw === undefined) return null;
  const rolling = isDateExpr(raw) ? rollingShift(raw) : null;
  if (!rolling)
    throw new Error(`a date offset reads { ago } or { ahead } (got ${JSON.stringify(raw)})`);
  return rolling;
};
