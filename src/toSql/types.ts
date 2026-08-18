import type { FieldMap } from '../toPrisma/types';
import type { DateConfig } from '../types';

export type { FieldMap } from '../toPrisma/types';

export type SqlResult = {
  sql: string;
  params: unknown[];
  joins: string[];
};

// gloss
export type BuilderState = {
  params: unknown[];
  paramIndex: number;
  context?: Record<string, unknown>;
  dateConfig?: DateConfig;
  map?: FieldMap;
  currentModel?: string;
  currentAlias?: string;
  joinCounter?: { n: number };
  joins?: string[];
  joinRegistry?: Map<string, string>;
};
