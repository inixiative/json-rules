import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';

export type Lens = {
  map: FieldMap | FieldMapSet;
  mapName?: string;
  model: string;
};

export type ModelNarrowing = {
  picks?: string[];
  omits?: string[];
  relations?: Record<string, ModelNarrowing>;
};

export type MapNarrowing = {
  models: Record<string, ModelNarrowing>;
};

export type LensNarrowing = {
  // TODO: may need to be an identifier (lens name/uuid) rather than a direct reference for persistence
  parent: Lens | LensNarrowing;
  maps: Record<string, MapNarrowing>;
  constrains?: Condition;
};
