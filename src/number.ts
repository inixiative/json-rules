import type { OrderedRuleValue } from './types';

// BigInt compares as Int: a bigint (what Prisma returns for a BigInt column) becomes a JS
// number on every side of a comparison, so 5n matches 5. Past ±2^53 a number cannot hold it
// exactly and every comparison would be silently wrong, so that throws instead.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export const bigIntToNumber = (value: bigint): number => {
  if (value > MAX_SAFE || value < -MAX_SAFE)
    throw new RangeError(
      `BigInt ${value} is outside the safe integer range (±2^53); json-rules compares BigInt as Int.`,
    );
  return Number(value);
};

export const toNumber = (raw: unknown): unknown => {
  if (typeof raw === 'bigint') return bigIntToNumber(raw);
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)))
    return Number(raw);
  return raw;
};

/** A source's number; null when it reads nothing. `what` names the slot in the error. */
export const readNumber = (raw: unknown, what: string): number | null => {
  if (raw === null || raw === undefined) return null;
  const value = toNumber(raw);
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${what} reads a number (got ${String(raw)})`);
  return value;
};

/** A pair in ascending order — a range's ends, however authored. */
export const orderPair = <T>([a, b]: readonly [T, T] | T[]): [T, T] =>
  (b as never) < (a as never) ? [b, a] : [a, b];

/** A range operand: two ends, or an error naming the operator. */
export const readPair = (value: unknown, operator: string): [unknown, unknown] => {
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`${operator} operator requires an array of two values`);
  return [value[0], value[1]];
};

/** A set operand: a list, or an error — a scalar is not a set. */
export const readSet = (value: unknown): unknown[] => {
  if (!Array.isArray(value))
    throw new Error(`in / notIn requires a list (got ${JSON.stringify(value)})`);
  return value;
};

/** A set operand's non-null members, and whether it names null. */
export const splitNull = (operand: unknown): { values: unknown[]; hasNull: boolean } => {
  const list = readSet(operand);
  const values = list.filter((v) => v !== null);
  return { values, hasNull: values.length !== list.length };
};

/** A value that orders: a string, a number or a Date — also every date input. */
export const isOrderedValue = (value: unknown): value is OrderedRuleValue =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;
