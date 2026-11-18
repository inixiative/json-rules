import { stitchFieldMaps } from '../fieldMap/stitch.ts';
import type { Lens } from './types.ts';

/** A lens over field maps, its bridges stitched into the maps as fields. Over a literal map
 *  (`typeof prismaMap`), `model` must be one of `mapName`'s models. */
export const createLens = <const L extends Lens>({
  maps,
  bridges,
  mapName,
  model,
}: L & { model: Extract<keyof L['maps'][L['mapName']]['models'], string> }): Lens => ({
  ...stitchFieldMaps({ maps, bridges }),
  mapName,
  model,
});
