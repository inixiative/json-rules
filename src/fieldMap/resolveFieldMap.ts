import { own } from '../own';
import type { FieldMap, FieldMapSet } from './types';

/** The FieldMap a compile reads: the map itself, or `mapName`'s map in a set — a set without a
 *  `mapName` is refused rather than read as a map (no Json paths, no bridges). */
export const resolveFieldMap = (
  map: FieldMap | FieldMapSet | undefined,
  mapName: string | undefined,
  target: 'toSql' | 'toPrisma',
): FieldMap | undefined => {
  if (!map || !('maps' in map)) return map;
  if (!mapName)
    throw new Error(
      `${target}: 'map' is a FieldMapSet — 'mapName' is required to resolve which map to use.`,
    );
  const resolved = own(map.maps, mapName);
  if (!resolved) throw new Error(`${target}: fieldMap set has no entry for '${mapName}'`);
  return resolved;
};
