import type { Condition } from '../types';
import type { SqlResult, BuilderState } from './types';
import { buildCondition } from './condition';

export type { SqlResult } from './types';

/**
 * Convert a json-rules Condition to a PostgreSQL WHERE clause.
 *
 * @param condition - The rule condition to convert
 * @returns Object with `sql` (WHERE clause fragment) and `params` array
 *
 * @example
 * ```typescript
 * import { toSql, Operator } from '@inixiative/json-rules';
 *
 * const rule = { field: 'status', operator: Operator.equals, value: 'active' };
 * const { sql, params } = toSql(rule);
 * // sql: '"status" = $1'
 * // params: ['active']
 *
 * // Complex rule
 * const rule2 = {
 *   all: [
 *     { field: 'deletedAt', operator: Operator.equals, value: null },
 *     { field: 'status', operator: Operator.in, value: ['active', 'pending'] }
 *   ]
 * };
 * const { sql: sql2, params: params2 } = toSql(rule2);
 * // sql: '("deletedAt" IS NULL AND "status" = ANY($1))'
 * // params: [['active', 'pending']]
 * ```
 */
export const toSql = (condition: Condition): SqlResult => {
  const state: BuilderState = { params: [], paramIndex: 0 };
  const sql = buildCondition(condition, state);
  return { sql, params: state.params };
};
