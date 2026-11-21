import { type Draft, modelOf, own } from '@inixiative/field-map';
import { endpointKey, isJoinedBridge } from './endpointKey.ts';
import type { FieldMapSet } from './types.ts';

/** A copy of the set where each bridge's endpoint models gain a `kind: 'bridge'` field named
 *  after the other endpoint (`<fieldMap>:<Model>`); a supplied bridge runs one way, so only its
 *  first endpoint gains one. Throws on a missing endpoint, a joined bridge's
 *  missing `on` field, an `on` on one side only, a supplied bridge that is not one-to-one, a
 *  self-bridge, or a bridge stitched twice. */
export const stitchFieldMaps = (set: FieldMapSet): FieldMapSet => {
  const out: { maps: Draft<FieldMapSet['maps']>; bridges: FieldMapSet['bridges'] } = {
    maps: structuredClone(set.maps) as Draft<FieldMapSet['maps']>,
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
    if (isJoinedBridge(bridge)) {
      const [aOn, bOn] = bridge.endpoints.map((endpoint) => endpoint.on);
      if (!own(aOwner.fields, aOn)) {
        throw new Error(`stitchFieldMaps: endpoint '${aKey}' has no field '${aOn}' for join`);
      }
      if (!own(bOwner.fields, bOn)) {
        throw new Error(`stitchFieldMaps: endpoint '${bKey}' has no field '${bOn}' for join`);
      }
    } else if (bridge.cardinality !== 'oneToOne' || bridge.endpoints.some((e) => 'on' in e)) {
      throw new Error(
        `stitchFieldMaps: bridge '${aKey}' ↔ '${bKey}' joins on one side only, or is a supplied bridge that is not oneToOne`,
      );
    }

    if (own(aOwner.fields, bKey)) {
      throw new Error(`stitchFieldMaps: bridge '${bKey}' already injected on '${aKey}'`);
    }
    if (isJoinedBridge(bridge) && own(bOwner.fields, aKey)) {
      throw new Error(`stitchFieldMaps: bridge '${aKey}' already injected on '${bKey}'`);
    }

    const isOneToMany = bridge.cardinality === 'oneToMany';
    aOwner.fields[bKey] = { kind: 'bridge', type: bKey, isList: isOneToMany };
    if (isJoinedBridge(bridge)) bOwner.fields[aKey] = { kind: 'bridge', type: aKey, isList: false };
  }

  return out;
};
