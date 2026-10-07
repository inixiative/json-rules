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
