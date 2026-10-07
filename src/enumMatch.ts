import { resolveCaseInsensitive } from './engineGlobals';
import { splitNull } from './number';
import { EQUALITY_OPERATORS, EXACT_OPERATORS, NEGATED_OPERATORS } from './operatorCatalog';
import { own } from './own';
import type { FieldMap, FieldMapEntry } from './toPrisma/types';
import type { Rule } from './types';

// An enum column compares exactly: a case-insensitive equality or membership compiles to the
// declared values that match ignoring case (Prisma has no case-insensitive mode on an enum), as
// does one naming a value the enum doesn't declare.
// String, pattern and ordered operators don't apply to an enum, as the catalog says.

/** An enum field's declared values: the entry's own, else the map's for its type. */
const enumValues = (
  entry: FieldMapEntry,
  map: FieldMap | undefined,
): readonly string[] | undefined => entry.values ?? own(map?.enums, entry.type);

/**
 * The declared values a case-insensitive equality or membership on an enum matches, and whether
 * a NULL field matches it — or null when the column answers the comparison itself.
 */
export const enumMatches = (
  rule: Rule,
  value: unknown,
  entry: FieldMapEntry,
  map: FieldMap | undefined,
): { values: string[]; matchesNull: boolean } | null => {
  if (!EXACT_OPERATORS.includes(rule.operator))
    throw new Error(
      `'${rule.operator}' does not apply to the enum '${rule.field}'; compare its values with equals / in.`,
    );
  const ci = resolveCaseInsensitive(rule.caseInsensitive);
  const declared = enumValues(entry, map);
  const { values, hasNull } = splitNull(
    EQUALITY_OPERATORS.includes(rule.operator) ? [value] : value,
  );
  // The column answers an exact comparison itself — unless a literal isn't a declared value,
  // which the database refuses to read; that matches no row.
  if (!ci && (!declared || values.every((v) => typeof v === 'string' && declared.includes(v))))
    return null;
  if (!declared)
    throw new Error(
      `'${rule.field}' is an enum: a case-insensitive comparison reads its declared values, which the map doesn't list.`,
    );
  const norm = (v: string) => (ci ? v.toLowerCase() : v);
  const wanted = new Set(values.filter((v) => typeof v === 'string').map((v) => norm(v as string)));
  const hit = declared.filter((v) => wanted.has(norm(v)));
  return NEGATED_OPERATORS.includes(rule.operator)
    ? { values: declared.filter((v) => !hit.includes(v)), matchesNull: !hasNull }
    : { values: hit, matchesNull: hasNull };
};
