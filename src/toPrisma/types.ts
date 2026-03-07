export type PrismaFilter = Record<string, unknown>;
export type PrismaWhere = Record<string, unknown>;

// FieldMap is structurally compatible with PrismaMap from @inixiative/prisma-map.
// It only requires the fields that json-rules needs for traversal.
export type FieldMapEntry = {
  kind: 'scalar' | 'object' | 'enum';
  type: string;
  isList?: boolean;
  fromFields?: string[];
  toFields?: string[];
  relationName?: string; // disambiguates multiple relations between same two models
};

export interface FieldMap {
  [modelName: string]: {
    dbName?: string | null;
    fields: {
      [fieldName: string]: FieldMapEntry;
    };
  };
}

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

// steps is always present; the last entry is always a WhereStep.
// GroupBySteps precede it when count-based relation filtering is needed.
export type ToPrismaResult = {
  steps: PrismaStep[];
};

export type BuildOptions = {
  map?: FieldMap;
  model?: string;
  context?: Record<string, unknown>;
};

// Mutable state threaded through build calls to accumulate intermediate groupBy steps
export type PrismaBuildState = {
  steps: GroupByStep[];
};
