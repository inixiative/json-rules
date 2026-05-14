import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap } from '../toPrisma/types.ts';

export type Lens = {
  map: FieldMap | FieldMapSet;
  mapName?: string;
  model: string;
};

export type LensNarrowing = {
  // TODO: may need to be an identifier (lens name/uuid) rather than a direct reference for persistence
  parent: Lens | LensNarrowing;
  picks?: string[];
  omits?: string[];
  constrains?: Record<string, unknown>;
};
