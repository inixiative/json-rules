import type { Condition } from '../types';
import { buildCondition } from './condition';
import type { BuildOptions, PrismaBuildState, ToPrismaResult } from './types';

export { executePrismaQueryPlan } from './execute';
export type {
  BuildOptions,
  FieldMap,
  FieldMapEntry,
  GroupByStep,
  PrismaStep,
  PrismaWhere,
  StepRef,
  ToPrismaResult,
  WhereStep,
} from './types';

/**
 * Convert a json-rules Condition to a Prisma query plan.
 *
 * Returns a `ToPrismaResult` with:
 * - `where` – the Prisma WHERE clause
 * - `steps` – optional array of groupBy steps for count-based relation filters
 *   (only present when `atLeast`/`atMost`/`exactly` operators are used with a map)
 *
 * When `steps` is present, pass the result to `executePrismaQueryPlan` to
 * resolve step refs before using `where` in a Prisma query.
 *
 * @param condition - The rule condition to convert
 * @param options   - Optional map, model, and context
 *
 * @example
 * ```typescript
 * // Simple scalar
 * toPrisma({ field: 'status', operator: Operator.equals, value: 'active' })
 * // → { where: { status: { equals: 'active' } } }
 *
 * // JSON field detection (map required)
 * toPrisma({ field: 'metadata.theme', operator: Operator.equals, value: 'dark' }, { map, model: 'User' })
 * // → { where: { metadata: { path: ['theme'], equals: 'dark' } } }
 *
 * // Context path ref
 * toPrisma({ field: 'userId', operator: Operator.equals, path: 'currentUser.id' }, { context: { currentUser: { id: '123' } } })
 * // → { where: { userId: { equals: '123' } } }
 *
 * // Multi-step (map required)
 * const plan = toPrisma({ field: 'posts', arrayOperator: 'atLeast', count: 3, condition: {...} }, { map, model: 'User' });
 * const where = await executePrismaQueryPlan(plan, { post: prisma.post });
 * await prisma.user.findMany({ where });
 * ```
 */
export const toPrisma = (condition: Condition, options?: BuildOptions): ToPrismaResult => {
  const state: PrismaBuildState = { steps: [] };
  const where = buildCondition(condition, options, state);
  return {
    steps: [...state.steps, { operation: 'where', where }],
  };
};
