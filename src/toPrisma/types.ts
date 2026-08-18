import type { PrismaProvider } from '../engineGlobals';
import type { FieldMapSet } from '../fieldMap/types';
import type { DateConfig } from '../types';

export type PrismaFilter = Record<string, unknown>;
export type PrismaWhere = Record<string, unknown>;

// gloss
export type SourceOption = { value: string; label?: string; groups?: string[] };

// gloss
export type FieldMapEntry = {
  kind: 'scalar' | 'object' | 'enum' | 'bridge';
  type: string;
  isList?: boolean;
  fromFields?: string[];
  toFields?: string[];
  relationName?: string;
  values?: readonly string[];
  options?: readonly SourceOption[];
  groupBy?: readonly string[];
};

export type ModelEntry = {
  dbName?: string | null;
  fields: Record<string, FieldMapEntry>;
};

// gloss
export type FieldMap = {
  models: Record<string, ModelEntry>;
  enums?: Record<string, readonly string[]>;
};

export type StepRef = { __step: number };

export type GroupByStep = {
  operation: 'groupBy';
  model: string;
  args: {
    by: string[];
    where: Record<string, unknown>;
    having: Record<string, unknown>;
  };
  extract: string;
};

export type WhereStep = {
  operation: 'where';
  where: Record<string, unknown>;
};

export type PrismaStep = GroupByStep | WhereStep;

// gloss
export type ToPrismaResult = {
  steps: PrismaStep[];
};

export type BuildOptions = {
  map?: FieldMap | FieldMapSet;
  mapName?: string;
  model?: string;
  context?: Record<string, unknown>;
  datasource?: { provider?: PrismaProvider };
} & DateConfig;

// gloss
export type PrismaBuildState = {
  steps: GroupByStep[];
};
