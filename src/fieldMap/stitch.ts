import type { FieldMapSet } from './types.ts';

export const stitchFieldMaps = (set: FieldMapSet): FieldMapSet => {
  const out: FieldMapSet = { maps: structuredClone(set.maps), bridges: set.bridges };

  for (const bridge of set.bridges ?? []) {
    const [a, b] = bridge.endpoints;
    const aOwner = out.maps[a.fieldMap]?.[a.model];
    const bOwner = out.maps[b.fieldMap]?.[b.model];
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
