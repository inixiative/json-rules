import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import { compileWithLens } from '../lens/compileUnderLens';
import type { Condition } from '../types';
import { buildCondition } from './condition';
import { recordRefs } from './sentinels';
import type { PrismaBuildState, PrismaStep, ToPrismaOptions, ToPrismaResult } from './types';

const normalizeOptions = (options?: ToPrismaOptions): ToPrismaOptions | undefined =>
  options?.map
    ? { ...options, map: resolveFieldMap(options.map, options.mapName, 'toPrisma') }
    : options;

export { executePrismaPlan } from './execute';
export type {
  GroupByStep,
  PrismaStep,
  PrismaWhere,
  StepRef,
  ToPrismaOptions,
  ToPrismaResult,
  WhereStep,
} from './types';

/**
 * Compile a condition to a Prisma query plan: `steps`, any groupBy steps (counts and relation
 * aggregates, which need `{ map, model }` or `{ lens }`) and then the final `where`. With `lens`,
 * the rule compiles narrowed by it, against its base lens. Run a plan with
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
 *
 * toPrisma(rule, { lens: narrowing, now }); // gated, narrowed, compiled against the base lens
 * ```
 */
export const toPrisma = (rule: Condition, compileOptions?: ToPrismaOptions): ToPrismaResult =>
  compileWithLens(rule, compileOptions, 'toPrisma', compilePrisma);

const compilePrisma = (condition: Condition, options?: ToPrismaOptions): ToPrismaResult => {
  const state: PrismaBuildState = { steps: [] };
  const where = buildCondition(condition, normalizeOptions(options), state);
  // Each step records where its own references sit; nothing else is ever resolved.
  const withRefs = <S extends PrismaStep>(step: S, root: unknown): S => {
    const refs = recordRefs(root);
    return refs.length ? { ...step, refs } : step;
  };
  return {
    steps: [
      ...state.steps.map((step) => withRefs(step, step.args)),
      withRefs({ operation: 'where' as const, where }, where),
    ],
  };
};
