import { own } from '@inixiative/field-map';
import type { Row } from '../types';
import { endpointKey, isJoinedBridge, parseEndpointKey } from './endpointKey.ts';
import type { BridgeDictionary } from './indexBridges.ts';
import type { Bridge, FieldMapSet } from './types.ts';

/** What the far ends of a record's bridges are filled from. */
export type BridgeData = {
  /** Far rows of the joined bridges, indexed by `indexBridges`. */
  joined?: BridgeDictionary;
  /** The one far row of each supplied bridge, by endpoint key (`actor:User`). */
  supplied?: Record<string, Row>;
};

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A key naming a model of one of the set's maps (`actor:User`): only a bridge may put a row there.
const namesBridgedModel = (set: FieldMapSet, key: string): boolean =>
  key.includes(':') && Object.hasOwn(set.maps, parseEndpointKey(key, '').mapName);

const withoutBridgeKeys = (set: FieldMapSet, row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !namesBridgedModel(set, key)));

const farRowsOf = (
  set: FieldMapSet,
  bridge: Bridge,
  nearIndex: number,
  record: Row,
  data: BridgeData,
): Row | Row[] | undefined => {
  const far = bridge.endpoints[1 - nearIndex];
  if (!isJoinedBridge(bridge)) {
    const row = own(data.supplied ?? {}, endpointKey(far));
    return isRow(row) ? withoutBridgeKeys(set, row) : undefined;
  }
  const near = bridge.endpoints[nearIndex];
  const farOn = bridge.endpoints[1 - nearIndex].on;
  const key = own(record, near.on);
  if (key === null || key === undefined) return undefined;
  const byKey = own(own(own(data.joined ?? {}, far.fieldMap) ?? {}, far.model) ?? {}, farOn);
  const found = byKey ? own(byKey, String(key)) : undefined;
  if (Array.isArray(found)) return found.filter(isRow).map((row) => withoutBridgeKeys(set, row));
  return isRow(found) ? withoutBridgeKeys(set, found) : undefined;
};

/**
 * `record`, a row of the endpoint `at` (`db:Conversation`), with its bridges filled: every key it
 * carries that names a model of the set's maps is dropped, and each bridge from `at` puts its far
 * row under the far endpoint's key — a joined bridge the row its `on` value finds in `data.joined`,
 * a supplied bridge the row `data.supplied` holds for it. A far row comes without bridge keys of its
 * own, and a far end with no row is left out (a rule reading it then reads a missing value). A
 * supplied row no supplied bridge of the set ends at throws.
 */
export const recordWithBridgeData = (
  set: FieldMapSet,
  at: string,
  record: Row,
  data: BridgeData = {},
): Row => {
  const bridges = set.bridges ?? [];
  for (const key of Object.keys(data.supplied ?? {}))
    if (
      !bridges.some(
        (bridge) =>
          !isJoinedBridge(bridge) && bridge.endpoints.some((end) => endpointKey(end) === key),
      )
    )
      throw new Error(`recordWithBridgeData: no supplied bridge ends at \`${key}\``);
  const out = withoutBridgeKeys(set, record);
  for (const bridge of bridges) {
    const nearIndex = bridge.endpoints.findIndex((end) => endpointKey(end) === at);
    if (nearIndex === -1) continue;
    const rows = farRowsOf(set, bridge, nearIndex, record, data);
    if (rows !== undefined) out[endpointKey(bridge.endpoints[1 - nearIndex])] = rows;
  }
  return out;
};
