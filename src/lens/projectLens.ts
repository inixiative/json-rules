import { projectModels } from './projectModels.ts';
import { type PathProjection, type ProjectOptions, projectPaths } from './projectPaths.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * What a narrowed lens exposes. `by: 'path'` (the default) projects each declared path — its
 * visible fields, `where` clauses and sources — keyed by dotted path. `by: 'model'` flattens the
 * whole surface into a Lens: every model a path or relation reaches, each field the union of its
 * visits, bridges kept only where an exposed field crosses them.
 */
export function projectLens(
  lensOrNarrowing: Lens | LensNarrowing,
  options?: ProjectOptions & { by?: 'path' },
): PathProjection;
export function projectLens(
  lensOrNarrowing: Lens | LensNarrowing,
  options: ProjectOptions & { by: 'model' },
): Lens;
export function projectLens(
  lensOrNarrowing: Lens | LensNarrowing,
  { by = 'path', ...options }: ProjectOptions & { by?: 'path' | 'model' } = {},
): PathProjection | Lens {
  return by === 'model'
    ? projectModels(lensOrNarrowing, options)
    : projectPaths(lensOrNarrowing, options);
}
