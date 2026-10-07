import { stitchFieldMaps } from '../fieldMap/stitch.ts';
import type { Lens } from './types.ts';

/** A lens over field maps, its bridges stitched into the maps as fields. */
export const createLens = ({ maps, bridges, mapName, model }: Lens): Lens => ({
  ...stitchFieldMaps({ maps, bridges }),
  mapName,
  model,
});
