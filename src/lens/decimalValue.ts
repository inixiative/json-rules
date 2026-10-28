import type { FieldMapEntry } from '../fieldMap/types';

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

const toNumber = (value: unknown): unknown => {
  if (typeof value === 'string') return NUMERIC_STRING.test(value) ? Number(value) : value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toNumber?: unknown }).toNumber === 'function'
  )
    return (value as { toNumber: () => number }).toNumber();
  return value;
};

/**
 * A column's value as projected rows carry it. A `Decimal` column reaches a row as a Decimal.js-like
 * object (a Prisma `Decimal`) or as its numeric-string JSON spelling; the row carries it as a number,
 * so rows stay plain JSON and `check()` compares it as the number it is. A list column converts each
 * element. Every other column, and a value that is not numeric, passes through as it is.
 */
export const decimalValue = (entry: FieldMapEntry | undefined, value: unknown): unknown => {
  if (entry?.kind !== 'scalar' || entry.type !== 'Decimal') return value;
  return Array.isArray(value) ? value.map(toNumber) : toNumber(value);
};
