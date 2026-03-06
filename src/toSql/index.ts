import type { Condition } from '../types';
import type { SqlResult, BuilderState, FieldMap } from './types';
import { buildCondition } from './condition';

export type { SqlResult, FieldMap } from './types';

type SqlBuildOptions = {
  map?: FieldMap;
  model?: string;
  alias?: string;    // root table alias, defaults to 't0' when map is provided
  context?: Record<string, any>;
};

/**
 * Convert a json-rules Condition to a PostgreSQL WHERE clause.
 *
 * @param condition - The rule condition to convert
 * @param options   - Optional map/model/alias for JOIN generation; context for path refs
 * @returns Object with `sql`, `params`, and `joins` (LEFT JOIN clauses)
 *
 * @example
 * ```typescript
 * // Simple field
 * const { sql, params } = toSql({ field: 'status', operator: Operator.equals, value: 'active' });
 * // sql: '"status" = $1'
 *
 * // Relation traversal with JOINs (map required)
 * const { sql, params, joins } = toSql(
 *   { field: 'author.email', operator: Operator.equals, value: 'a@b.com' },
 *   { map, model: 'Post', alias: 't0' }
 * );
 * // sql:  '"t1"."email" = $1'
 * // joins: ['LEFT JOIN "User" AS "t1" ON "t1"."id" = "t0"."authorId"']
 *
 * // Same-record field comparison ($.field)
 * const { sql: sql2 } = toSql({ field: 'endDate', operator: Operator.greaterThan, path: '$.startDate' });
 * // sql2: '"endDate" > "startDate"'
 *
 * // External context ref
 * const { sql: sql3 } = toSql(
 *   { field: 'userId', operator: Operator.equals, path: 'currentUser.id' },
 *   { context: { currentUser: { id: '123' } } }
 * );
 * // sql3: '"userId" = $1'  params: ['123']
 * ```
 */
export const toSql = (condition: Condition, options?: SqlBuildOptions): SqlResult => {
  const hasMap = !!(options?.map && options?.model);
  const rootAlias = options?.alias ?? (hasMap ? 't0' : undefined);

  const state: BuilderState = {
    params: [],
    paramIndex: 0,
    context: options?.context,
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
