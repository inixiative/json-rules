import { groupBy, keyBy } from 'lodash';
import type { FieldMapSet } from './types.ts';

type Row = Record<string, unknown>;

export type BridgeIndex = Record<string, Record<string, Row | Row[]>>;

export const buildBridgeIndex = (set: FieldMapSet, rawData: Record<string, Row[]>): BridgeIndex => {
  const out: BridgeIndex = {};
  for (const bridge of set.bridges ?? []) {
    const [a, b] = bridge.endpoints;
    const aKey = `${a.fieldMap}:${a.model}`;
    const bKey = `${b.fieldMap}:${b.model}`;
    if (rawData[aKey]) out[aKey] = keyBy(rawData[aKey], a.on);
    if (rawData[bKey]) {
      out[bKey] =
        bridge.cardinality === 'oneToMany'
          ? groupBy(rawData[bKey], b.on)
          : keyBy(rawData[bKey], b.on);
    }
  }
  return out;
};
