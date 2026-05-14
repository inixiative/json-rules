import type { Bridge, FieldMapSet } from './types.ts';

export const stitchFieldMaps = (set: FieldMapSet, bridges: Bridge[]): FieldMapSet => {
  const out: FieldMapSet = structuredClone(set);

  for (const bridge of bridges) {
    const [a, b] = bridge.endpoints;
    const aOwner = out[a.fieldMap]?.[a.model];
    const bOwner = out[b.fieldMap]?.[b.model];
    if (!aOwner) {
      throw new Error(`stitchFieldMaps: endpoint '${a.fieldMap}:${a.model}' not found`);
    }
    if (!bOwner) {
      throw new Error(`stitchFieldMaps: endpoint '${b.fieldMap}:${b.model}' not found`);
    }

    const aKey = `${a.fieldMap}:${a.model}`;
    const bKey = `${b.fieldMap}:${b.model}`;

    if (aOwner.fields[bKey]) {
      throw new Error(`stitchFieldMaps: bridge '${bKey}' already injected on '${aKey}'`);
    }
    if (bOwner.fields[aKey]) {
      throw new Error(`stitchFieldMaps: bridge '${aKey}' already injected on '${bKey}'`);
    }

    const isOneToMany = bridge.cardinality === 'oneToMany';
    aOwner.fields[bKey] = { kind: 'bridge', type: bKey, isList: isOneToMany };
    bOwner.fields[aKey] = { kind: 'bridge', type: aKey, isList: false };
  }

  return out;
};
