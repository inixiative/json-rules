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
