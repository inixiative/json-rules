import { own } from '../own';
import { assertConditionDepth } from '../traverse';
import type { Condition } from '../types';
import { buildCondition } from './condition';
import type { BuildOptions, FieldMap, PrismaBuildState, ToPrismaResult } from './types';

const normalizeOptions = (options?: BuildOptions): BuildOptions | undefined => {
  if (!options?.map) return options;
  const mapIsSet = 'maps' in options.map;
  // Catch the silent-degradation case: a FieldMapSet without a mapName would
  // otherwise be passed through as if it were a FieldMap, producing queries
  // that lack map-awareness (no JSON-path detection, no bridge handling).
  if (mapIsSet && !options.mapName) {
    throw new Error(
      `toPrisma: 'map' is a FieldMapSet — 'mapName' is required to resolve which map to use.`,
    );
  }
  if (!mapIsSet || !options.mapName) return options;
  const resolved = own((options.map as { maps: Record<string, FieldMap> }).maps, options.mapName);
  if (!resolved) {
    throw new Error(`toPrisma: fieldMap set has no entry for '${options.mapName}'`);
  }
  return { ...options, map: resolved };
};

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
