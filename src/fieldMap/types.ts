import type { FieldMap } from '../toPrisma/types.ts';

export type FieldMapSet = Record<string, FieldMap>;

export type BridgeEndpoint = {
  fieldMap: string;
  model: string;
};

export type BridgeCardinality = 'oneToOne' | 'oneToMany';

export type Bridge = {
  endpoints: [BridgeEndpoint, BridgeEndpoint];
  cardinality: BridgeCardinality;
};
