import type { FieldRef } from './columnRef';
import type { SentinelRef } from './sentinels';
import type { GroupByStep, ToPrismaResult, WhereStep } from './types';

/**
 * Execute a Prisma query plan produced by toPrisma().
 *
 * The plan is a flat list of steps where all but the last are `groupBy` steps
 * that feed results (via { __step: N } references) into subsequent steps.
 * The final step is always a `where` step whose resolved WHERE clause is returned. A column
 * compared with a column is a `{ __field }` reference resolved to the delegate's field reference
 * (`prisma.user.fields.age`). Each step's `refs` record where its references sit, and only those
 * locations are resolved: a value shaped like a reference anywhere else stays data. Read a plan's
 * where only through here — Prisma rejects an unresolved reference.
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
    const args = resolveRefs(step.args, step.refs, stepResults, prismaDelegate);
    const rows = await delegate[step.operation](args);
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

  return resolveRefs(whereStep.where, whereStep.refs, stepResults, prismaDelegate) as Record<
    string,
    unknown
  >;
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

const readAt = (root: unknown, path: readonly (string | number)[]): unknown =>
  path.reduce<unknown>(
    (at, key) =>
      at !== null && typeof at === 'object' && Object.hasOwn(at, key)
        ? (at as Record<string | number, unknown>)[key]
        : undefined,
    root,
  );

// A copy of `root` with `value` at `path`, copying each container on the way (the plan is not
// mutated).
const writeAt = (root: unknown, path: readonly (string | number)[], value: unknown): unknown => {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  const container = root as Record<string | number, unknown>;
  const copy = (Array.isArray(root) ? [...root] : { ...container }) as Record<
    string | number,
    unknown
  >;
  copy[key] = writeAt(container[key], rest, value);
  return copy;
};

/**
 * Put each of the plan's own references in place — a `{ __step }` by that step's results, a
 * `{ __field }` by the delegate's field reference — at the locations the step records, and
 * nowhere else: a value shaped like a reference anywhere else is data.
 */
const resolveRefs = (
  root: unknown,
  refs: readonly SentinelRef[] | undefined,
  stepResults: unknown[][],
  prismaDelegate: Record<string, object>,
): unknown => {
  let out = root;
  for (const { path } of refs ?? []) {
    const sentinel = readAt(root, path) as Record<string, unknown> | undefined;
    if (sentinel && typeof sentinel.__step === 'number') {
      const idx = sentinel.__step;
      if (idx >= stepResults.length)
        throw new Error(
          `Step ref __step: ${idx} out of range (${stepResults.length} steps executed)`,
        );
      out = writeAt(out, path, stepResults[idx]);
    } else if (sentinel && typeof sentinel.__field === 'object' && sentinel.__field !== null) {
      out = writeAt(out, path, fieldRef(prismaDelegate, sentinel.__field as FieldRef['__field']));
    } else {
      throw new Error(`executePrismaPlan: no reference at the recorded location ${path.join('.')}`);
    }
  }
  return out;
};
