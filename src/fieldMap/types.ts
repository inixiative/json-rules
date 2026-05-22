import type { FieldMap } from '../toPrisma/types.ts';

export type BridgeEndpoint = {
  fieldMap: string;
  model: string;
  on: string;
};

export type BridgeCardinality = 'oneToOne' | 'oneToMany';

export type Bridge = {
  endpoints: [BridgeEndpoint, BridgeEndpoint];
  cardinality: BridgeCardinality;
};

export type FieldMapSet = {
  maps: Record<string, FieldMap>;
  bridges?: Bridge[];
};
