import type { BridgeEndpoint } from './types.ts';

/** The name a bridge endpoint goes by — `map:Model`: the stitched bridge field's name and the
 *  raw-data key. */
export const endpointKey = ({
  fieldMap,
  model,
}: Pick<BridgeEndpoint, 'fieldMap' | 'model'>): string => `${fieldMap}:${model}`;

/** The map and model an endpoint key names; a bare model is in `currentMap`. */
export const parseEndpointKey = (
  key: string,
  currentMap: string,
): { mapName: string; modelName: string } => {
  const at = key.indexOf(':');
  return at === -1
    ? { mapName: currentMap, modelName: key }
    : { mapName: key.slice(0, at), modelName: key.slice(at + 1) };
};
