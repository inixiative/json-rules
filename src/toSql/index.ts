import type { Condition, DateConfig } from '../types';
import { buildCondition } from './condition';
import type { BuilderState, FieldMap, SqlResult } from './types';

export type { FieldMap, SqlResult } from './types';

type SqlBuildOptions = {
  map?: FieldMap;
  model?: string;
  alias?: string; // root table alias, defaults to 't0' when map is provided
  context?: Record<string, unknown>;
} & DateConfig;

export const toSql = (condition: Condition, options?: SqlBuildOptions): SqlResult => {
  const hasMap = !!(options?.map && options?.model);
  const rootAlias = options?.alias ?? (hasMap ? 't0' : undefined);

  const state: BuilderState = {
    params: [],
    paramIndex: 0,
    context: options?.context,
    dateConfig: { now: options?.now, timeZone: options?.timeZone, weekStart: options?.weekStart },
    map: options?.map,
    currentModel: options?.model,
    currentAlias: rootAlias,
    joinCounter: hasMap ? { n: 0 } : undefined,
    joins: hasMap ? [] : undefined,
    joinRegistry: hasMap ? new Map() : undefined,
  };

  const sql = buildCondition(condition, state);
  return { sql, params: state.params, joins: state.joins ?? [] };
};
