import { groupBy, keyBy } from 'lodash';
import type { FieldMapSet } from './types.ts';

type Row = Record<string, unknown>;

export type BridgeDictionary = Record<
  string, // map name
  Record<
    string, // model name
    Record<string, Record<string, Row | Row[]>> // on field → identifier → row(s)
  >
>;

export const buildBridgeDictionary = (
  set: FieldMapSet,
  rawData: Record<string, Row[]>,
): BridgeDictionary => {
  const out: BridgeDictionary = {};
  for (const bridge of set.bridges ?? []) {
    const [a, b] = bridge.endpoints;
    const aKey = `${a.fieldMap}:${a.model}`;
    const bKey = `${b.fieldMap}:${b.model}`;
    if (rawData[aKey]) {
      out[a.fieldMap] ??= {};
      out[a.fieldMap][a.model] ??= {};
      out[a.fieldMap][a.model][a.on] = keyBy(rawData[aKey], a.on);
    }
    if (rawData[bKey]) {
      out[b.fieldMap] ??= {};
      out[b.fieldMap][b.model] ??= {};
      out[b.fieldMap][b.model][b.on] =
        bridge.cardinality === 'oneToMany'
          ? groupBy(rawData[bKey], b.on)
          : keyBy(rawData[bKey], b.on);
    }
  }
  return out;
};
