import { own } from '../own';
import type { FieldMap, FieldMapEntry } from './types';

export type MapWalkResult =
  | { kind: 'direct'; entry?: FieldMapEntry }
  | { kind: 'json-path'; stopIndex: number; jsonPath: string[] }
  | { kind: 'bridge' }
  | { kind: 'fallback' };

/**
 * Walk a dot-notation field path through the FieldMap.
 *
 * Returns how to interpret the path:
 * - 'direct'    – all segments are relations/scalars, use standard nested filter;
 *                 `entry` is the terminal field's map entry
 * - 'json-path' – a Json scalar was found mid-path; stopIndex segments form the
 *                 Prisma nested key, the rest become the JSON path array
 * - 'fallback'  – a segment was not found in the map; use existing behavior
 */
/**
 * The dotted prefixes of `field` that end on an OPTIONAL to-one relation (`kind: 'object'`,
 * not a list, `isRequired: false`), outermost first — every hop at which the path can be
 * absent as a whole. A required hop, a list hop, an unmapped segment, or the terminal
 * segment contributes nothing. Same licensing authority as isRequired on a column.
 */
export const optionalToOneHops = (field: string, map: FieldMap, rootModel: string): string[] => {
  const parts = field.split('.');
  const hops: string[] = [];
  let currentModel = rootModel;
  for (let i = 0; i < parts.length - 1; i++) {
    const modelEntry = map.models[currentModel];
    if (!modelEntry) return hops;
    const fieldEntry = own(modelEntry.fields, parts[i]);
    if (fieldEntry?.kind !== 'object' || !map.models[fieldEntry.type]) return hops;
    if (!fieldEntry.isList && fieldEntry.isRequired === false)
      hops.push(parts.slice(0, i + 1).join('.'));
    currentModel = fieldEntry.type;
  }
  return hops;
};

export const walkFieldPath = (field: string, map: FieldMap, rootModel: string): MapWalkResult => {
  const parts = field.split('.');
  let currentModel = rootModel;

  for (let i = 0; i < parts.length; i++) {
    const modelEntry = map.models[currentModel];
    if (!modelEntry) return { kind: 'fallback' };

    const fieldEntry = own(modelEntry.fields, parts[i]);
    if (!fieldEntry) return { kind: 'fallback' };

    if (fieldEntry.kind === 'bridge') return { kind: 'bridge' };

    if (fieldEntry.kind === 'scalar' && fieldEntry.type === 'Json' && i < parts.length - 1) {
      // This segment is a Json field and there are more segments → JSON path
      return { kind: 'json-path', stopIndex: i + 1, jsonPath: parts.slice(i + 1) };
    }

    if (fieldEntry.kind === 'object') {
      if (!map.models[fieldEntry.type]) return { kind: 'fallback' };
      if (i === parts.length - 1) return { kind: 'direct', entry: fieldEntry };
      currentModel = fieldEntry.type;
      continue;
    }

    // scalar or enum at a terminal position
    return { kind: 'direct', entry: fieldEntry };
  }

  return { kind: 'direct' };
};
