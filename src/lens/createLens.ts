import { stitchFieldMaps } from '../fieldMap/stitch.ts';
import type { Bridge, FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap } from '../toPrisma/types.ts';
import type { Lens } from './types.ts';

export type CreateLensInput = {
  maps: Record<string, FieldMap>;
  bridges?: Bridge[];
  mapName: string;
  model: string;
};

export const createLens = (input: CreateLensInput): Lens => {
  const stitched: FieldMapSet = stitchFieldMaps({ maps: input.maps, bridges: input.bridges });
  return { ...stitched, mapName: input.mapName, model: input.model };
};
