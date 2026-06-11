import type { FieldMap } from '../toPrisma/types';
import type { DateConfig } from '../types';

export type { FieldMap } from '../toPrisma/types';

export type SqlResult = {
  sql: string;
  params: unknown[];
  joins: string[];
};

export type BuilderState = {
  params: unknown[];
  paramIndex: number;
  context?: Record<string, unknown>;
  dateConfig?: DateConfig;
  // Map-aware state (only populated when map+model are provided)
  map?: FieldMap;
  currentModel?: string;
  currentAlias?: string;
  joinCounter?: { n: number };
  joins?: string[];
  // Registry: "parentAlias.fieldName" → assigned alias (prevents duplicate JOINs)
  joinRegistry?: Map<string, string>;
};
