import type { FieldMap, FieldMapEntry } from './types';

export const findReverseRelation = (
  map: FieldMap,
  targetModel: string,
  currentModel: string,
  relationName?: string,
): FieldMapEntry | null => {
  const targetEntry = map[targetModel];
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
