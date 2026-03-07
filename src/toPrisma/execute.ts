import type { GroupByStep, ToPrismaResult, WhereStep } from './types';

/**
 * Execute a Prisma query plan produced by toPrisma().
 *
 * The plan is a flat list of steps where all but the last are `groupBy` steps
 * that feed results (via { __step: N } sentinels) into subsequent steps.
 * The final step is always a `where` step whose resolved WHERE clause is returned.
 *
 * @param result         - Result from toPrisma()
 * @param prismaDelegate - Map of camelCase model name → Prisma delegate
 *                         e.g. { post: prisma.post, user: prisma.user }
 * @returns The resolved WHERE clause (ready for findMany/count/etc.)
 *
 * @example
 * const plan = toPrisma(condition, { map, model: 'User' });
 * const where = await executePrismaQueryPlan(plan, { post: prisma.post });
 * await prisma.user.findMany({ where });
 */
export const executePrismaQueryPlan = async (
  result: ToPrismaResult,
  prismaDelegate: Record<string, Record<string, (...args: unknown[]) => unknown>>,
): Promise<Record<string, unknown>> => {
  const groupBySteps = result.steps.filter((s): s is GroupByStep => s.operation === 'groupBy');
  const whereStep = result.steps.find((s): s is WhereStep => s.operation === 'where');

  if (!whereStep) {
    throw new Error('executePrismaQueryPlan: result has no where step');
  }

  const stepResults: unknown[][] = [];

  for (const step of groupBySteps) {
    const modelKey = step.model.charAt(0).toLowerCase() + step.model.slice(1);
    const delegate = prismaDelegate[modelKey];
    if (!delegate) {
      throw new Error(
        `executePrismaQueryPlan: no delegate for model '${step.model}'. ` +
          `Ensure prismaDelegate has a key '${modelKey}'.`,
      );
    }
    const rows = await delegate[step.operation](step.args);
    stepResults.push((rows as Record<string, unknown>[]).map((r) => r[step.extract]));
  }

  return resolveStepRefs(whereStep.where, stepResults) as Record<string, unknown>;
};

/**
 * Recursively replace { __step: N } sentinels with the corresponding step result array.
 */
const resolveStepRefs = (obj: unknown, stepResults: unknown[][]): unknown => {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveStepRefs(item, stepResults));
  }

  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;

    if ('__step' in record && typeof record.__step === 'number') {
      const idx = record.__step;
      if (idx >= stepResults.length) {
        throw new Error(
          `Step ref __step: ${idx} out of range (${stepResults.length} steps executed)`,
        );
      }
      return stepResults[idx];
    }

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      resolved[key] = resolveStepRefs(value, stepResults);
    }
    return resolved;
  }

  return obj;
};
