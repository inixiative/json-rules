import { groupBy } from 'lodash-es';
import type { FieldMapSet } from './types.ts';

type Row = Record<string, unknown>;

export type BridgeDictionary = Record<
  string, // map name
  Record<
    string, // model name
    Record<string, Record<string, Row | Row[]>> // on field → identifier → row(s)
  >
>;

const keyByUnique = (
  rows: Row[],
  on: string,
  endpointLabel: string,
  side: 'one' | 'oneToOne',
): Record<string, Row> => {
  const out: Record<string, Row> = {};
  for (const row of rows) {
    const k = row[on] as string | number | undefined;
    if (k === undefined || k === null) continue;
    const key = String(k);
    if (out[key] !== undefined) {
      const hint =
        side === 'one'
          ? `endpoint[0] must be the "one" side of a oneToMany bridge — swap endpoints if '${endpointLabel}' is the "many" side`
          : `oneToOne bridges require unique '${on}' on both endpoints`;
      throw new Error(
        `buildBridgeDictionary: duplicate '${on}' value '${key}' on '${endpointLabel}' — ${hint}.`,
      );
    }
    out[key] = row;
  }
  return out;
};

export const buildBridgeDictionary = (
  set: FieldMapSet,
  rawData: Record<string, Row[]>,
): BridgeDictionary => {
  const out: BridgeDictionary = {};
  for (const bridge of set.bridges ?? []) {
    const [a, b] = bridge.endpoints;
    const aKey = `${a.fieldMap}:${a.model}`;
    const bKey = `${b.fieldMap}:${b.model}`;
    const aSide = bridge.cardinality === 'oneToMany' ? 'one' : 'oneToOne';
    if (rawData[aKey]) {
      out[a.fieldMap] ??= {};
      out[a.fieldMap][a.model] ??= {};
      out[a.fieldMap][a.model][a.on] = keyByUnique(rawData[aKey], a.on, aKey, aSide);
    }
    if (rawData[bKey]) {
      out[b.fieldMap] ??= {};
      out[b.fieldMap][b.model] ??= {};
      if (bridge.cardinality === 'oneToMany') {
        // Filter null/undefined `on` values — lodash groupBy would otherwise stringify
        // them into 'null'/'undefined' keys, causing spurious joins when looking up
        // rows whose own join field is null.
        const valid = rawData[bKey].filter((row) => row[b.on] !== null && row[b.on] !== undefined);
        out[b.fieldMap][b.model][b.on] = groupBy(valid, b.on);
      } else {
        out[b.fieldMap][b.model][b.on] = keyByUnique(rawData[bKey], b.on, bKey, 'oneToOne');
      }
    }
  }
  return out;
};
