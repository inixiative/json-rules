import type { FieldMapEntry } from './fieldMap/types';
import { CONTAINS_OPERATORS, EQUALITY_OPERATORS } from './operatorCatalog';

/**
 * Why a column compared with a column can't compile exactly, or null. A list column compares with
 * a column only by membership (`contains` / `notContains` of a scalar column); an enum compares only with an enum of
 * its own type, and only for equality: a database orders an enum by declaration, check() by text.
 */
export const columnCompareProblem = (
  field: FieldMapEntry | undefined,
  column: FieldMapEntry | undefined,
  operator: string,
): string | null => {
  if (field?.isList || column?.isList) {
    // A list holding a column's value is membership, which SQL compiles exactly; any other
    // comparison with a list column compares an array with a value.
    const membership = field?.isList && !column?.isList && CONTAINS_OPERATORS.includes(operator);
    if (!membership) return 'a list column compares with no column but by membership';
    if (field?.kind !== 'enum' && column?.kind !== 'enum') return null;
  }
  const enums = [field, column].filter((entry) => entry?.kind === 'enum');
  if (enums.length === 0) return null;
  if (enums.length === 1 || field?.type !== column?.type)
    return 'an enum compares only with an enum column of its own type';
  if (!EQUALITY_OPERATORS.includes(operator))
    return `an enum column orders by declaration on the database, not as check() compares its text ('${operator}')`;
  return null;
};
