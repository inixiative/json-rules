import type { ToPrismaResult, WhereStep } from '../../index';

/** Extract the final WhereStep's `where` from a ToPrismaResult. */
export const getWhere = (result: ToPrismaResult): Record<string, unknown> => {
  const last = result.steps[result.steps.length - 1] as WhereStep;
  return last.where;
};
