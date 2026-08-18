import { groupBy } from 'lodash-es';
import type { FieldMapSet } from './types.ts';

type Row = Record<string, unknown>;

// gloss
export type BridgeDictionary = Record<
  string,
  Record<string, Record<string, Record<string, Row | Row[]>>>
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

// gloss
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
        // why: lodash groupBy stringifies null/undefined into 'null'/'undefined' keys → spurious joins
        const valid = rawData[bKey].filter((row) => row[b.on] !== null && row[b.on] !== undefined);
        out[b.fieldMap][b.model][b.on] = groupBy(valid, b.on);
      } else {
        out[b.fieldMap][b.model][b.on] = keyByUnique(rawData[bKey], b.on, bKey, 'oneToOne');
      }
    }
  }
  return out;
};
