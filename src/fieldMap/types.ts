// gloss:file

import type { FieldMap } from '../toPrisma/types.ts';

export type BridgeEndpoint = {
  fieldMap: string;
  model: string;
  on: string;
};

export type BridgeCardinality = 'oneToOne' | 'oneToMany';

// gloss
export type Bridge = {
  // why: endpoints[0] must be the unique "one" side — swapping flips isList and silently dedups rows
  endpoints: [BridgeEndpoint, BridgeEndpoint];
  cardinality: BridgeCardinality;
};

export type FieldMapSet = {
  maps: Record<string, FieldMap>;
  bridges?: Bridge[];
};
