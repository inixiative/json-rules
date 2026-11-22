import type {
  Bridge,
  BridgeEndpoint,
  FieldMapEntry,
  JoinedBridge,
  JoinedBridgeEndpoint,
} from './types.ts';

/** Whether a bridge endpoint stands for `model` of `fieldMap`: it names that model, or names only the map. */
export const endpointCoversModel = (
  endpoint: Bridge['endpoints'][number],
  fieldMap: string,
  model: string,
): boolean =>
  endpoint.fieldMap === fieldMap && (!('model' in endpoint) || endpoint.model === model);

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

/** The bridge declared between `(mapName, model)` and `farKey` (`map:Model`), oriented from the
 *  near side; null when no declared bridge connects them. */
export const findBridgeBetween = (
  bridges: readonly Bridge[] | undefined,
  mapName: string,
  model: string,
  farKey: string,
): {
  bridge: Bridge;
  near: Bridge['endpoints'][number];
  far: BridgeEndpoint | JoinedBridgeEndpoint;
} | null => {
  for (const bridge of bridges ?? []) {
    const [a, b] = bridge.endpoints;
    for (const [near, far] of [
      [a, b],
      [b, a],
    ] as const) {
      if (
        endpointCoversModel(near, mapName, model) &&
        'model' in far &&
        endpointKey(far) === farKey
      )
        return { bridge, near, far };
    }
  }
  return null;
};

/** The `{ here, there }` join-key pair for a stitched joined bridge field from `(mapName, model)`
 *  to `entry.type`; null for a supplied bridge, a non-bridge entry, or an undeclared bridge. */
export const bridgeJoinKeys = (
  bridges: readonly Bridge[] | undefined,
  mapName: string,
  model: string,
  entry: FieldMapEntry,
): { here: string; there: string } | null => {
  if (entry.kind !== 'bridge') return null;
  const found = findBridgeBetween(bridges, mapName, model, entry.type);
  if (!found || !('on' in found.near) || !('on' in found.far)) return null;
  return { here: found.near.on, there: found.far.on };
};
