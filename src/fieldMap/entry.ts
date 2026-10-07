import { own } from '../own';
import type { FieldMapEntry } from './types';

/**
 * A Json column. It declares no sub-fields, so a dotted sub-path into it is open-ended —
 * `check`/`toPrisma`/`toSql` resolve the remaining segments against the JSON value at
 * evaluation time. Lens path resolution stops at this boundary.
 */
export const isJsonEntry = (entry: FieldMapEntry): boolean =>
  entry.kind === 'scalar' && entry.type === 'Json';

/** A relation to another model, in this source or across a bridge. */
export const isRelationEntry = (entry: FieldMapEntry): boolean =>
  entry.kind === 'object' || entry.kind === 'bridge';

/** An enum field's declared values: the entry's own, else the registry's for its type. */
export const declaredEnumValues = (
  entry: FieldMapEntry,
  enums: Record<string, readonly string[]> | undefined,
): readonly string[] | undefined => entry.values ?? own(enums, entry.type);
