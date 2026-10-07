import { modelOf, own } from '../own';
import { endpointKey } from './endpointKey.ts';
import type { FieldMapSet } from './types.ts';

export const stitchFieldMaps = (set: FieldMapSet): FieldMapSet => {
  const out: FieldMapSet = {
    maps: structuredClone(set.maps),
    bridges: set.bridges ? structuredClone(set.bridges) : undefined,
  };

  for (const bridge of set.bridges ?? []) {
    const [a, b] = bridge.endpoints;
    const aKey = endpointKey(a);
    const bKey = endpointKey(b);
    const aOwner = modelOf(own(out.maps, a.fieldMap), a.model);
    const bOwner = modelOf(own(out.maps, b.fieldMap), b.model);
    if (!aOwner) {
      throw new Error(`stitchFieldMaps: endpoint '${aKey}' not found`);
    }
    if (!bOwner) {
      throw new Error(`stitchFieldMaps: endpoint '${bKey}' not found`);
    }
    if (a.fieldMap === b.fieldMap && a.model === b.model) {
      throw new Error(`stitchFieldMaps: self-bridge '${aKey}' to itself is not supported`);
    }
    if (!own(aOwner.fields, a.on)) {
      throw new Error(`stitchFieldMaps: endpoint '${aKey}' has no field '${a.on}' for join`);
    }
    if (!own(bOwner.fields, b.on)) {
      throw new Error(`stitchFieldMaps: endpoint '${bKey}' has no field '${b.on}' for join`);
    }

    if (own(aOwner.fields, bKey)) {
      throw new Error(`stitchFieldMaps: bridge '${bKey}' already injected on '${aKey}'`);
    }
    if (own(bOwner.fields, aKey)) {
      throw new Error(`stitchFieldMaps: bridge '${aKey}' already injected on '${bKey}'`);
    }

    const isOneToMany = bridge.cardinality === 'oneToMany';
    aOwner.fields[bKey] = { kind: 'bridge', type: bKey, isList: isOneToMany };
    bOwner.fields[aKey] = { kind: 'bridge', type: aKey, isList: false };
  }

  return out;
};
