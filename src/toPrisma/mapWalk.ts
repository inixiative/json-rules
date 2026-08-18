import type { FieldMap, FieldMapEntry } from './types';

export type MapWalkResult =
  | { kind: 'direct'; entry?: FieldMapEntry }
  | { kind: 'json-path'; stopIndex: number; jsonPath: string[] }
  | { kind: 'bridge' }
  | { kind: 'fallback' };

// gloss
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
      return { kind: 'json-path', stopIndex: i + 1, jsonPath: parts.slice(i + 1) };
    }

    if (fieldEntry.kind === 'object') {
      if (!map.models[fieldEntry.type]) return { kind: 'fallback' };
      if (i === parts.length - 1) return { kind: 'direct', entry: fieldEntry };
      currentModel = fieldEntry.type;
      continue;
    }

    return { kind: 'direct', entry: fieldEntry };
  }

  return { kind: 'direct' };
};
