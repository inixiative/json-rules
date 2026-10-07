import { isDateExpr, rollingShift } from './dateExpr';
import { readNumber, toNumber } from './number';
import type { RelativeUnits } from './types';

// An offset moves a leaf's comparison value. It reads its own value source: a number on a field
// rule, a rolling `{ ago }` / `{ ahead }` on a date rule.

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
