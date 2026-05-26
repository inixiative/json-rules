import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { isFieldVisible, resolvePolicy, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

export type ProjectedVisit = {
  mapName: string;
  modelName: string;
  fields: Record<string, FieldMapEntry>;
  whereClauses: Condition[];
};

export type PathProjection = Map<string, ProjectedVisit>;

export const projectByPath = (lensOrNarrowing: Lens | LensNarrowing): PathProjection => {
  const policy = resolvePolicy(lensOrNarrowing);
  const out: PathProjection = new Map();

  const visit = (
    mapName: string,
    modelName: string,
    relPath: string[],
    dottedPath: string,
  ): void => {
    if (out.has(dottedPath)) return;
    const model = policy.lens.maps[mapName]?.models[modelName];
    if (!model) return;

    const effect = resolveVisit(policy, mapName, modelName, relPath);

    const fields: Record<string, FieldMapEntry> = {};
    for (const [fieldName, entry] of Object.entries(model.fields)) {
      if (!isFieldVisible(effect, fieldName)) continue;
      const narrowedEnumValues = effect.enumValuesByField.get(fieldName);
      fields[fieldName] =
        narrowedEnumValues !== undefined ? { ...entry, values: narrowedEnumValues } : entry;
    }

    out.set(dottedPath, { mapName, modelName, fields, whereClauses: effect.whereClauses });

    for (const relField of effect.relations.keys()) {
      const entry = model.fields[relField];
      if (!entry) continue;
      const target = resolveRelationTarget(entry, mapName);
      if (!target) continue;
      visit(target.mapName, target.modelName, [...relPath, relField], `${dottedPath}.${relField}`);
    }
  };

  visit(policy.lens.mapName, policy.lens.model, [], policy.lens.model);
  return out;
};
