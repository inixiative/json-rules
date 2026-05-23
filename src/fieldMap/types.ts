import type { FieldMap } from '../toPrisma/types.ts';

export type BridgeEndpoint = {
  fieldMap: string;
  model: string;
  on: string;
};

export type BridgeCardinality = 'oneToOne' | 'oneToMany';

/**
 * A cross-source edge between two endpoints.
 *
 * Endpoint ordering convention for `oneToMany`:
 *   - `endpoints[0]` is the "one" side — its `on` field must be unique per row
 *     (typically a primary key).
 *   - `endpoints[1]` is the "many" side — its `on` field may repeat across rows
 *     (typically a foreign key).
 *
 * Mis-ordering produces wrong `isList` flags during stitching and silent
 * row-dedup when building bridge dictionaries. `buildBridgeDictionary` throws
 * at runtime if endpoint[0]'s data has duplicate `on` values to catch this.
 *
 * For `oneToOne`, both `on` fields must be unique; endpoint order is symmetric.
 */
export type Bridge = {
  endpoints: [BridgeEndpoint, BridgeEndpoint];
  cardinality: BridgeCardinality;
};

export type FieldMapSet = {
  maps: Record<string, FieldMap>;
  bridges?: Bridge[];
};
