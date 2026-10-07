import { modelOf } from '../own';
import type { FieldMap, FieldMapEntry } from './types';

export const findReverseRelation = (
  map: FieldMap,
  targetModel: string,
  currentModel: string,
  relationName?: string,
): FieldMapEntry | null => {
  const targetEntry = modelOf(map, targetModel);
  if (!targetEntry) return null;

  for (const fieldDef of Object.values(targetEntry.fields)) {
    if (
      fieldDef.kind === 'object' &&
      fieldDef.type === currentModel &&
      (fieldDef.fromFields?.length ?? 0) > 0 &&
      (fieldDef.toFields?.length ?? 0) > 0 &&
      (relationName === undefined || fieldDef.relationName === relationName)
    ) {
      return fieldDef;
    }
  }
  return null;
};

/**
 * The column pairs that link a model to the target of one of its relations — `here` on the
 * model, `there` on the target — from the relation's own FK (forward) or its reverse side
 * (back-relation). Null when the map doesn't say. A composite FK has several pairs.
 */
export const relationKeys = (
  map: FieldMap,
  model: string,
  entry: FieldMapEntry,
): { here: string; there: string }[] | null => {
  if (entry.fromFields?.length)
    return entry.fromFields.map((from, i) => ({ here: from, there: entry.toFields?.[i] ?? 'id' }));
  const reverse = findReverseRelation(map, entry.type, model, entry.relationName);
  if (!reverse?.fromFields?.length) return null;
  return reverse.fromFields.map((from, i) => ({
    here: reverse.toFields?.[i] ?? 'id',
    there: from,
  }));
};
