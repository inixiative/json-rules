import type { PathProjection, ProjectedVisit, ToPrismaResult, WhereStep } from '../../index';

/** Extract the final WhereStep's `where` from a ToPrismaResult. */
export const getWhere = (result: ToPrismaResult): Record<string, unknown> => {
  const last = result.steps[result.steps.length - 1] as WhereStep;
  return last.where;
};

/** Look up a path in a PathProjection; throws with a clear message if missing. */
export const at = (proj: PathProjection, path: string): ProjectedVisit => {
  const v = proj.get(path);
  if (!v) throw new Error(`expected projection visit at path '${path}'`);
  return v;
};

type Opt = { value: string; label?: string };

/** The normalized picker options a value-gated field exposes: `{ value, label: value }`. */
export const enumOptions = (...values: string[]): Opt[] =>
  values.map((v) => ({ value: v, label: v }));

/** A field's `options` sorted by value — order-independent comparison for unioned surfaces. */
export const sortedOptions = (entry: { options?: readonly Opt[] }): Opt[] =>
  [...(entry.options ?? [])].sort((a, b) => a.value.localeCompare(b.value));
