import type { FieldMapSet } from '../fieldMap/types.ts';
import type { Condition } from '../types.ts';

// gloss
export type Lens = FieldMapSet & {
  mapName: string;
  model: string;
};

// gloss
export type ModelDefaultNarrowing = {
  picks?: string[];
  omits?: string[];
  enumPicks?: Record<string, readonly string[]>;
  enumOmits?: Record<string, readonly string[]>;
  where?: Condition;
  sources?: Record<string, SourceValue>;
};

// gloss
export type SourceSpec =
  | { where: Condition; label?: string; groupBy?: string | string[] }
  | { where?: Condition; label: string; groupBy?: string | string[] }
  | { where?: Condition; label?: string; groupBy: string | string[] };

// gloss
export type SourceValue = Condition | SourceSpec;

// gloss
export type ModelNarrowing = ModelDefaultNarrowing & {
  relations?: Record<string, ModelNarrowing>;
};

// gloss
export type EnumNarrowing = {
  picks?: readonly string[];
  omits?: readonly string[];
};

// gloss
export type NarrowingDefaults = {
  models?: Record<string, ModelDefaultNarrowing>;
  enums?: Record<string, EnumNarrowing>;
};

// gloss
export type LensNarrowing = {
  parent: Lens | LensNarrowing;
  root?: ModelNarrowing;
  mapDefaults?: Record<string, NarrowingDefaults>;
};
