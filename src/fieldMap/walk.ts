import { fieldOf, own } from '../own';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types';
import { parseEndpointKey } from './endpointKey.ts';

/** A model a walk stands on, and the relation path that reached it. */
export type MapVisit = { mapName: string; modelName: string; relPath: readonly string[] };

/** One segment of a walk: the entry it names at `at` (undefined when undeclared), and the model a
 *  relation entry leads to. */
export type MapStep = {
  index: number;
  field: string;
  at: MapVisit;
  entry: FieldMapEntry | undefined;
  next: { mapName: string; modelName: string } | null;
};

/** The model a relation entry leads to, in this map or across a bridge; null for a column. */
export const relationTargetOf = (
  entry: FieldMapEntry,
  currentMap: string,
): { mapName: string; modelName: string } | null => {
  if (entry.kind === 'object') return { mapName: currentMap, modelName: entry.type };
  if (entry.kind === 'bridge') return parseEndpointKey(entry.type, currentMap);
  return null;
};

/**
 * The one walk of a dotted path through field maps: each segment read at the model the previous
 * relation reached. It ends after an undeclared segment or a column; callers stop earlier where
 * their semantics do (a bridge, a hidden field, a Json boundary).
 */
export function* walkMaps(
  maps: Record<string, FieldMap>,
  from: MapVisit,
  path: string,
): Generator<MapStep> {
  const parts = path.split('.');
  let at: MapVisit = from;
  for (let index = 0; index < parts.length; index++) {
    const field = parts[index];
    const entry = fieldOf(own(maps, at.mapName), at.modelName, field);
    const next = entry ? relationTargetOf(entry, at.mapName) : null;
    yield { index, field, at, entry, next };
    if (!next) return;
    at = { ...next, relPath: [...at.relPath, field] };
  }
}
