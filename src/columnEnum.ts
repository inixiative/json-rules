import type { FieldMapEntry } from './fieldMap/types';
import { Operator } from './operator';

/**
 * Why a column compared with a column can't compile exactly when either is an enum, or null. An
 * enum compares only with an enum of its own type, and only for equality: a database orders an
 * enum by declaration, check() by its text.
 */
export const enumColumnProblem = (
  field: FieldMapEntry | undefined,
  column: FieldMapEntry | undefined,
  operator: string,
): string | null => {
  const enums = [field, column].filter((entry) => entry?.kind === 'enum');
  if (enums.length === 0) return null;
  if (enums.length === 1 || field?.type !== column?.type)
    return 'an enum compares only with an enum column of its own type';
  if (operator !== Operator.equals && operator !== Operator.notEquals)
    return `an enum column orders by declaration on the database, not as check() compares its text ('${operator}')`;
  return null;
};
