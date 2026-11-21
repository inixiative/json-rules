import { own } from '@inixiative/field-map';
import { isPlainObject } from 'lodash-es';
import type { Row } from '../types';
import { endpointKey, isJoinedBridge, parseEndpointKey } from './endpointKey.ts';
import { type BridgeDictionary, indexBridges } from './indexBridges.ts';
import type { Bridge, FieldMapSet } from './types.ts';

const isRow = (value: unknown): value is Row => isPlainObject(value);

// A key naming a model of one of the set's maps (`actor:User`): only a bridge may put a row there.
const namesBridgedModel = (set: FieldMapSet, key: string): boolean =>
  key.includes(':') && Object.hasOwn(set.maps, parseEndpointKey(key, '').mapName);

const withoutBridgeKeys = (set: FieldMapSet, row: Row): Row =>
  Object.fromEntries(Object.entries(row).filter(([key]) => !namesBridgedModel(set, key)));

// The far rows one bridge from `near` reaches, as they came in `data` (not yet filled).
const farRowsOf = (
  set: FieldMapSet,
  bridge: Bridge,
  nearIndex: number,
  record: Row,
  data: Record<string, Row[]>,
  dictionary: BridgeDictionary,
): Row | Row[] | undefined => {
  const far = bridge.endpoints[1 - nearIndex];
  if (!isJoinedBridge(bridge)) {
    // a supplied bridge's second endpoint is the one whose row the data supplies
    if (nearIndex !== 0) return undefined;
    const rows = own(data, endpointKey(far));
    if (rows === undefined) return undefined;
    if (!Array.isArray(rows) || rows.length !== 1 || !isRow(rows[0]))
      throw new Error(
        `recordWithBridgeData: \`${endpointKey(far)}\` is the far end of a supplied bridge: give it one row`,
      );
    return rows[0];
  }
  const key = own(record, bridge.endpoints[nearIndex].on);
  if (key === null || key === undefined) return undefined;
  const byValue = own(dictionary, far.fieldMap)?.[far.model]?.[bridge.endpoints[1 - nearIndex].on];
  const found = byValue ? own(byValue, String(key)) : undefined;
  if (Array.isArray(found)) return found.filter(isRow);
  return isRow(found) ? found : undefined;
};

// why: a chain may cross many sources; it never re-enters an endpoint it came through, so it ends
const filled = (
  set: FieldMapSet,
  at: string,
  record: Row,
  data: Record<string, Row[]>,
  dictionary: BridgeDictionary,
  came: ReadonlySet<string>,
): Row => {
  const out = withoutBridgeKeys(set, record);
  const through = new Set([...came, at]);
  for (const bridge of set.bridges ?? []) {
    const nearIndex = bridge.endpoints.findIndex((end) => endpointKey(end) === at);
    if (nearIndex === -1) continue;
    const farKey = endpointKey(bridge.endpoints[1 - nearIndex]);
    if (through.has(farKey)) continue;
    const rows = farRowsOf(set, bridge, nearIndex, record, data, dictionary);
    if (rows === undefined) continue;
    out[farKey] = Array.isArray(rows)
      ? rows.map((row) => filled(set, farKey, row, data, dictionary, through))
      : filled(set, farKey, rows, data, dictionary, through);
  }
  return out;
};

/**
 * `record`, a row of the endpoint `at` (`app:Doc`) of a stitched set, with every bridge filled from `data` (rows keyed
 * by endpoint, `<fieldMap>:<Model>`, as `indexBridges` takes them), and the far rows' bridges in
 * turn, so a rule can read across a chain of sources (`crm:Contact.sec:Device.risk`). Every key a
 * row carries that names a model of the set's maps is dropped before its bridges are filled, so no
 * row on any side brings its own. A joined bridge gives the row its `on` value finds, a supplied
 * bridge (from its first endpoint to its second) the one row `data` holds for its second. A chain
 * never re-enters an endpoint it came through, and a far end with no row is left out, so a rule
 * reading it reads a missing value.
 */
export const recordWithBridgeData = (
  set: FieldMapSet,
  at: string,
  record: Row,
  data: Record<string, Row[]> = {},
): Row => filled(set, at, record, data, indexBridges(set, data), new Set());
