import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap } from '../toPrisma/types.ts';
import { projectNarrowing } from './project.ts';
import type { Lens, LensNarrowing } from './types.ts';

const isLens = (x: Lens | LensNarrowing): x is Lens => 'model' in x;

const getRoot = (x: Lens | LensNarrowing): Lens => (isLens(x) ? x : getRoot(x.parent));

const resolveAnchor = (lens: Lens): { mapName: string; modelName: string } => {
  const first = Object.values(lens.map)[0];
  if (first && 'fields' in first) {
    return { mapName: lens.mapName ?? 'default', modelName: lens.model };
  }
  if (!lens.mapName) {
    throw new Error('snapshotLens: lens.mapName required when map is a FieldMapSet');
  }
  return { mapName: lens.mapName, modelName: lens.model };
};

// JSON-serializable snapshot of a projected lens surface. Store alongside rules
// so eval can reconstruct the exact field surface visible at rule-creation time
// without re-querying provider DB tables.
export type LensSnapshot = {
  mapName: string;
  model: string;
  fieldMapSet: FieldMapSet;
};

export const snapshotLens = (lensOrNarrowing: Lens | LensNarrowing): LensSnapshot => {
  const root = getRoot(lensOrNarrowing);
  const { mapName, modelName } = resolveAnchor(root);
  const fieldMapSet = projectNarrowing(lensOrNarrowing);
  return { mapName, model: modelName, fieldMapSet };
};

// Reconstructs a Lens from a stored snapshot for use in eval-time checkRuleAgainstLens.
export const lensFromSnapshot = (snapshot: LensSnapshot): Lens => ({
  map: snapshot.fieldMapSet,
  mapName: snapshot.mapName,
  model: snapshot.model,
});
