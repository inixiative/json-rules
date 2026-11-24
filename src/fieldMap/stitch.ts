import { type Draft, modelOf, own } from '@inixiative/field-map';
import { endpointKey, isJoinedBridge } from './endpointKey.ts';
import type { FieldMapSet } from './types.ts';

/** A copy of the set where each bridge's endpoint models gain a `kind: 'bridge'` field named
 *  after the other endpoint (`<fieldMap>:<Model>`); a supplied bridge runs one way, so only its
 *  first endpoint gains one, and when that endpoint names only its map, every model of the map
 *  does (but the far model itself). Throws on a missing endpoint, a joined bridge's
 *  missing `on` field, an `on` on one side only, a supplied bridge that is not one-to-one, a
 *  self-bridge, or a bridge stitched twice. */
export const stitchFieldMaps = (set: FieldMapSet): FieldMapSet => {
  const out: { maps: Draft<FieldMapSet['maps']>; bridges: FieldMapSet['bridges'] } = {
    maps: structuredClone(set.maps) as Draft<FieldMapSet['maps']>,
    bridges: set.bridges ? structuredClone(set.bridges) : undefined,
  };

  for (const bridge of set.bridges ?? []) {
    const [a, b] = bridge.endpoints;
    if (!('model' in b)) {
      throw new Error(
        `stitchFieldMaps: the far end of a supplied bridge names a model (got map '${(b as { fieldMap: string }).fieldMap}' alone)`,
      );
    }
    const bKey = endpointKey(b);
    const bOwner = modelOf(own(out.maps, b.fieldMap), b.model);
    if (!bOwner) {
      throw new Error(`stitchFieldMaps: endpoint '${bKey}' not found`);
    }
    if (!('model' in a)) {
      if (bridge.endpoints.some((endpoint) => 'on' in endpoint)) {
        throw new Error(
          `stitchFieldMaps: a joined bridge names a model at both ends (map '${a.fieldMap}' alone to '${bKey}')`,
        );
      }
      if (bridge.cardinality !== 'oneToOne') {
        throw new Error(
          `stitchFieldMaps: bridge map '${a.fieldMap}' ↔ '${bKey}' is a supplied bridge that is not oneToOne`,
        );
      }
      const aMap = own(out.maps, a.fieldMap);
      if (!aMap) throw new Error(`stitchFieldMaps: map '${a.fieldMap}' not found`);
      for (const [modelName, model] of Object.entries(aMap.models)) {
        if (a.fieldMap === b.fieldMap && modelName === b.model) continue;
        if (own(model.fields, bKey)) {
          throw new Error(
            `stitchFieldMaps: bridge '${bKey}' already injected on '${endpointKey({ fieldMap: a.fieldMap, model: modelName })}'`,
          );
        }
        model.fields[bKey] = { kind: 'bridge', type: bKey, isList: false };
      }
      continue;
    }
    const aKey = endpointKey(a);
    const aOwner = modelOf(own(out.maps, a.fieldMap), a.model);
    if (!aOwner) {
      throw new Error(`stitchFieldMaps: endpoint '${aKey}' not found`);
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
