import type { FieldMap } from '../fieldMap/types';
import type { CompileOptions, DateConfig } from '../types';

export type ToSqlResult = {
  sql: string;
  params: unknown[];
  joins: string[];
};

export type BuilderState = {
  params: unknown[];
  paramIndex: number;
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

export type ToSqlOptions = CompileOptions & {
  /** The root table alias; `t0` when a map is given. */
  alias?: string;
};
