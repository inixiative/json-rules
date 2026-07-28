import type { FieldMap, FieldMapEntry } from './types';

export type MapWalkResult =
  | { kind: 'direct' }
  | { kind: 'json-path'; stopIndex: number; jsonPath: string[] }
  | { kind: 'bridge' }
  | { kind: 'fallback' };

/**
 * Walk a dot-notation field path through the FieldMap.
 *
 * Returns how to interpret the path:
 * - 'direct'    – all segments are relations/scalars, use standard nested filter
 * - 'json-path' – a Json scalar was found mid-path; stopIndex segments form the
 *                 Prisma nested key, the rest become the JSON path array
 * - 'fallback'  – a segment was not found in the map; use existing behavior
 */
export const walkFieldPath = (field: string, map: FieldMap, rootModel: string): MapWalkResult => {
  const parts = field.split('.');
  let currentModel = rootModel;

  for (let i = 0; i < parts.length; i++) {
    const modelEntry = map.models[currentModel];
    if (!modelEntry) return { kind: 'fallback' };

    const fieldEntry = modelEntry.fields[parts[i]];
    if (!fieldEntry) return { kind: 'fallback' };

    if (fieldEntry.kind === 'bridge') return { kind: 'bridge' };

    if (fieldEntry.kind === 'scalar' && fieldEntry.type === 'Json' && i < parts.length - 1) {
      // This segment is a Json field and there are more segments → JSON path
      return { kind: 'json-path', stopIndex: i + 1, jsonPath: parts.slice(i + 1) };
    }

    if (fieldEntry.kind === 'object') {
      if (!map.models[fieldEntry.type]) return { kind: 'fallback' };
      currentModel = fieldEntry.type;
      continue;
    }

    // scalar or enum at a terminal position
    return { kind: 'direct' };
  }

  return { kind: 'direct' };
};

/**
 * The terminal field's map entry for a dot-notation path, walking to-one
 * relations exactly like {@link walkFieldPath}. `undefined` when any segment
 * fails to resolve (including a Json mid-path — the sub-path's value type is
 * unknowable from the map) — callers treat that as "type unknown".
 */
export const leafFieldEntry = (
  field: string,
  map: FieldMap,
  rootModel: string,
): FieldMapEntry | undefined => {
  const parts = field.split('.');
  let currentModel = rootModel;

  for (let i = 0; i < parts.length; i++) {
    const fieldEntry = map.models?.[currentModel]?.fields[parts[i]];
    if (!fieldEntry) return undefined;
    if (i === parts.length - 1) return fieldEntry;
    if (fieldEntry.kind !== 'object' || !map.models[fieldEntry.type]) return undefined;
    currentModel = fieldEntry.type;
  }

  return undefined;
};
