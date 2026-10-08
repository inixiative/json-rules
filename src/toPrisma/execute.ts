import type { FieldRef } from './columnRef';
import type { GroupByStep, ToPrismaResult, WhereStep } from './types';

/**
 * Execute a Prisma query plan produced by toPrisma().
 *
 * The plan is a flat list of steps where all but the last are `groupBy` steps
 * that feed results (via { __step: N } sentinels) into subsequent steps.
 * The final step is always a `where` step whose resolved WHERE clause is returned. A column
 * compared with a column is a `{ __field }` sentinel resolved to the delegate's field reference
 * (`prisma.user.fields.age`): read a plan's where only through here — Prisma rejects the sentinel.
 *
 * @param result         - Result from toPrisma()
 * @param prismaDelegate - Map of camelCase model name → Prisma delegate (or the client)
 *                         e.g. { post: prisma.post, user: prisma.user }
 * @returns The resolved WHERE clause (ready for findMany/count/etc.)
 *
 * @example
 * const plan = toPrisma(condition, { map, model: 'User' });
 * const where = await executePrismaPlan(plan, { post: prisma.post });
 * await prisma.user.findMany({ where });
 */
export const executePrismaPlan = async (
  plan: ToPrismaResult,
  prismaDelegate: Record<string, object>,
): Promise<Record<string, unknown>> => {
  const groupBySteps = plan.steps.filter((s): s is GroupByStep => s.operation === 'groupBy');
  const whereStep = plan.steps.find((s): s is WhereStep => s.operation === 'where');

  if (!whereStep) {
    throw new Error('executePrismaPlan: result has no where step');
  }

  const stepResults: unknown[][] = [];

  for (const step of groupBySteps) {
    const delegate = delegateOf(prismaDelegate, step.model) as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    const rows = await delegate[step.operation](step.args);
    // A related row whose join FK is null belongs to no root entity, so it can
    // never contribute a membership id. groupBy over a nullable FK still emits a
    // null group, and Prisma rejects a mixed null+string array in `in`/`notIn`,
    // so drop nulls here at the gather point. An empty result stays a real `[]`:
    // `in: []` matches nothing and `notIn: []` matches everything, both correct.
    stepResults.push(
      (rows as Record<string, unknown>[])
        .map((r) => r[step.extract])
        .filter((v) => v !== null && v !== undefined),
    );
  }

  return resolveStepRefs(whereStep.where, stepResults, prismaDelegate) as Record<string, unknown>;
};

const delegateOf = (prismaDelegate: Record<string, object>, model: string): object => {
  const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
  // A Prisma client exposes its delegates (and a delegate its `fields`) as getters, not own keys.
  const delegate = (prismaDelegate as Record<string, object | undefined>)[modelKey];
  if (!delegate)
    throw new Error(
      `executePrismaPlan: no delegate for model '${model}'. ` +
        `Ensure prismaDelegate has a key '${modelKey}'.`,
    );
  return delegate;
};

// A `{ __field }` column reference: the delegate's field reference, `<delegate>.fields.<field>`.
const fieldRef = (prismaDelegate: Record<string, object>, ref: FieldRef['__field']): unknown => {
  const fields = (delegateOf(prismaDelegate, ref.model) as { fields?: Record<string, unknown> })
    .fields;
  const field = fields && Object.hasOwn(fields, ref.field) ? fields[ref.field] : undefined;
  if (field === undefined)
    throw new Error(
      `executePrismaPlan: the '${ref.model}' delegate has no field reference '${ref.field}' (fields.${ref.field}).`,
    );
  return field;
};

/**
 * Recursively replace { __step: N } sentinels with the corresponding step result array, and
 * { __field } sentinels with the delegate's field reference.
 */
const resolveStepRefs = (
  obj: unknown,
  stepResults: unknown[][],
  prismaDelegate: Record<string, object>,
): unknown => {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map((item) => resolveStepRefs(item, stepResults, prismaDelegate));
  }

  if (typeof obj === 'object') {
    // Only plain objects are walked — a compiled leaf like a Date (or Decimal/
    // Buffer) must pass through untouched; entry-copying it would strip its
    // prototype and hand Prisma an empty object.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return obj;
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
    if (Object.hasOwn(record, '__field'))
      return fieldRef(prismaDelegate, record.__field as FieldRef['__field']);

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      resolved[key] = resolveStepRefs(value, stepResults, prismaDelegate);
    }
    return resolved;
  }

  return obj;
};
