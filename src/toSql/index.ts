import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import type { FieldMapSet } from '../fieldMap/types';
import { assertConditionDepth } from '../traverse';
import type { Condition, DateConfig } from '../types';
import { buildCondition } from './condition';
import type { BuilderState, FieldMap, SqlResult } from './types';

export type { FieldMap, SqlResult } from './types';

export type SqlBuildOptions = {
  /** A FieldMap, or a FieldMapSet with `mapName`. */
  map?: FieldMap | FieldMapSet;
  mapName?: string;
  model?: string;
  alias?: string; // root table alias, defaults to 't0' when map is provided
  context?: Record<string, unknown>;
} & DateConfig;

/** A fresh compile: the root alias (`t0` with a map), parameters, and the join registry every
 *  field resolved against it shares. */
export const builderState = (options?: SqlBuildOptions): BuilderState => {
  const map = resolveFieldMap(options?.map, options?.mapName, 'toSql');
  const hasMap = !!(map && options?.model);
  const rootAlias = options?.alias ?? (hasMap ? 't0' : undefined);
  return {
    params: [],
    paramIndex: 0,
    context: options?.context,
    dateConfig: { now: options?.now, timeZone: options?.timeZone, weekStart: options?.weekStart },
    map,
    currentModel: options?.model,
    currentAlias: rootAlias,
    joinCounter: hasMap ? { n: 0 } : undefined,
    joins: hasMap ? [] : undefined,
    joinRegistry: hasMap ? new Map() : undefined,
  };
};

export const toSql = (condition: Condition, options?: SqlBuildOptions): SqlResult => {
  assertConditionDepth(condition);
  const state = builderState(options);
  const sql = buildCondition(condition, state);
  return { sql, params: state.params, joins: state.joins ?? [] };
};
