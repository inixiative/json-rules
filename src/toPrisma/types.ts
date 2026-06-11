import type { FieldMapSet } from '../fieldMap/types';
import type { DateConfig } from '../types';

export type PrismaFilter = Record<string, unknown>;
export type PrismaWhere = Record<string, unknown>;

// FieldMap is structurally compatible with PrismaMap from @inixiative/prisma-map.
// It only requires the fields that json-rules needs for traversal.
export type FieldMapEntry = {
  kind: 'scalar' | 'object' | 'enum' | 'bridge';
  type: string;
  isList?: boolean;
  fromFields?: string[];
  toFields?: string[];
  relationName?: string; // disambiguates multiple relations between same two models
  /**
   * Per-field allowed values, primarily for enum fields. Takes precedence over
   * `FieldMap.enums[type]` if both are set. Pass-through from codegen
   * (e.g. prisma-map's `EnumField.values`). Consumed by `checkRuleAgainstLens`.
   */
  values?: readonly string[];
};

export type ModelEntry = {
  dbName?: string | null;
  fields: Record<string, FieldMapEntry>;
};

/**
 * A schema map: models keyed by name, plus an optional enum registry scoped to
 * this source. In multi-source setups (Prisma + Salesforce + CRM) each FieldMap
 * carries its own enums so namespaces don't collide across sources.
 */
export type FieldMap = {
  models: Record<string, ModelEntry>;
  /** Enum name → allowed values, e.g. `{ UserRole: ['ADMIN', 'USER'] }`. */
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

// steps is always present; the last entry is always a WhereStep.
// GroupBySteps precede it when count-based relation filtering is needed.
export type ToPrismaResult = {
  steps: PrismaStep[];
};

export type BuildOptions = {
  map?: FieldMap | FieldMapSet;
  mapName?: string;
  model?: string;
  context?: Record<string, unknown>;
} & DateConfig;

// Mutable state threaded through build calls to accumulate intermediate groupBy steps
export type PrismaBuildState = {
  steps: GroupByStep[];
};
