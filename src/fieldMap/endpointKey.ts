import type { Bridge, BridgeEndpoint, JoinedBridge } from './types.ts';

/** The name a bridge endpoint goes by — `map:Model`: the stitched bridge field's name and the
 *  raw-data key. */
export const endpointKey = ({ fieldMap, model }: BridgeEndpoint): string => `${fieldMap}:${model}`;

/** Whether a bridge joins on a field of each side, or its far row is supplied on the record. */
export const isJoinedBridge = (bridge: Bridge): bridge is JoinedBridge =>
  bridge.endpoints.every((endpoint) => 'on' in endpoint);

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
