import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import { assertConditionDepth } from '../traverse';
import type { Condition } from '../types';
import { buildCondition } from './condition';
import type { BuildOptions, PrismaBuildState, ToPrismaResult } from './types';

const normalizeOptions = (options?: BuildOptions): BuildOptions | undefined =>
  options?.map
    ? { ...options, map: resolveFieldMap(options.map, options.mapName, 'toPrisma') }
    : options;

export { executePrismaPlan } from './execute';
export type {
  BuildOptions,
  FieldMap,
  FieldMapEntry,
  GroupByStep,
  PrismaStep,
  PrismaWhere,
  SourceOption,
  StepRef,
  ToPrismaResult,
  WhereStep,
} from './types';

/**
 * Compile a condition to a Prisma query plan: `steps`, any groupBy steps (counts and relation
 * aggregates, which need `{ map, model }`) and then the final `where`. Run a plan with
 * `executePrismaPlan(plan, client)` to resolve step refs; a single-step plan's `where` is its
 * last step's.
 *
 * @example
 * ```typescript
 * toPrisma({ field: 'status', operator: Operator.equals, value: 'active' }).steps
 * // → [{ operation: 'where', where: { status: { equals: 'active' } } }]
 *
 * const plan = toPrisma({ field: 'posts', arrayOperator: 'atLeast', count: 3, condition }, { map, model: 'User' });
 * const where = await executePrismaPlan(plan, prisma);
 * await prisma.user.findMany({ where });
 * ```
 */
export const toPrisma = (condition: Condition, options?: BuildOptions): ToPrismaResult => {
  assertConditionDepth(condition);
  const state: PrismaBuildState = { steps: [] };
  const where = buildCondition(condition, normalizeOptions(options), state);
  return {
    steps: [...state.steps, { operation: 'where', where }],
  };
};
