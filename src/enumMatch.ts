import { check } from './check';
import { resolveCaseInsensitive } from './engineGlobals';
import { EXACT_OPERATORS } from './operatorCatalog';
import { own } from './own';
import type { FieldMap, FieldMapEntry } from './toPrisma/types';
import type { Condition, Rule } from './types';

// A database compares an enum by declaration order and exactly, and has no string operators
// for it; check() compares its values as strings. A compiler resolves such a comparison against
// the enum's declared values instead — check() decides which of them match — so the rails agree.

/** An enum field's declared values: the entry's own, else the map's for its type. */
export const enumValues = (
  entry: FieldMapEntry,
  map: FieldMap | undefined,
): readonly string[] | undefined => entry.values ?? own(map?.enums, entry.type);

/**
 * The declared values a comparison on an enum matches, and whether a NULL field matches it —
 * or null when the column answers it natively. `value` is the operand already read.
 */
export const enumMatches = (
  rule: Rule,
  value: unknown,
  entry: FieldMapEntry,
  map: FieldMap | undefined,
): { values: string[]; matchesNull: boolean } | null => {
  if (EXACT_OPERATORS.includes(rule.operator) && !resolveCaseInsensitive(rule.caseInsensitive))
    return null;
  const declared = enumValues(entry, map);
  if (!declared)
    throw new Error(
      `'${rule.field}' is an enum: '${rule.operator}'${rule.caseInsensitive ? ' (case-insensitive)' : ''} compares its declared values, which the map doesn't list.`,
    );
  const { path, bind, bindOptional, offset, ...literal } = rule as Rule & Record<string, unknown>;
  const holds = (v: string | null) =>
    check({ ...literal, field: 'v', value } as Condition, { v }) === true;
  return { values: declared.filter(holds), matchesNull: holds(null) };
};
