import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types';
import { projectNarrowing } from './project.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { getRoot, resolveRelationTarget } from './walk.ts';

const walkPath = (
  set: FieldMapSet,
  startMap: string,
  startModel: string,
  path: string,
): { entry: FieldMapEntry; mapName: string; modelName: string } | null => {
  const parts = path.split('.');
  let mapName = startMap;
  let modelName = startModel;
  for (let i = 0; i < parts.length; i++) {
    const model: FieldMap[string] | undefined = set.maps[mapName]?.[modelName];
    if (!model) return null;
    const entry = model.fields[parts[i]];
    if (!entry) return null;
    if (i === parts.length - 1) return { entry, mapName, modelName };
    if (entry.kind === 'object') {
      modelName = entry.type;
      continue;
    }
    if (entry.kind === 'bridge') {
      const [m, n] = entry.type.includes(':') ? entry.type.split(':') : [mapName, entry.type];
      mapName = m;
      modelName = n;
      continue;
    }
    return null;
  }
  return null;
};

export type RuleLensViolation = {
  path: string;
  reason: string;
};

export type RuleLensCheck = {
  ok: boolean;
  violations: RuleLensViolation[];
};

const visit = (
  cond: Condition,
  set: FieldMapSet,
  mapName: string,
  modelName: string,
  violations: RuleLensViolation[],
): void => {
  if (typeof cond === 'boolean') return;
  if ('all' in cond) {
    for (const c of cond.all) visit(c, set, mapName, modelName, violations);
    return;
  }
  if ('any' in cond) {
    for (const c of cond.any) visit(c, set, mapName, modelName, violations);
    return;
  }
  if ('if' in cond) {
    visit(cond.if, set, mapName, modelName, violations);
    visit(cond.then, set, mapName, modelName, violations);
    if (cond.else !== undefined) visit(cond.else, set, mapName, modelName, violations);
    return;
  }

  let nextMap = mapName;
  let nextModel = modelName;

  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const resolved = walkPath(set, mapName, modelName, cond.field);
    if (!resolved) {
      violations.push({
        path: cond.field,
        reason: 'path does not resolve through the narrowed lens',
      });
      return;
    }
    const target = resolveRelationTarget(resolved.entry, resolved.mapName);
    if (target) {
      nextMap = target.mapName;
      nextModel = target.modelName;
    }
  }

  if ('condition' in cond && cond.condition !== undefined) {
    visit(cond.condition, set, nextMap, nextModel, violations);
  }
};

export const checkRuleAgainstLens = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): RuleLensCheck => {
  const root = getRoot(lensOrNarrowing);
  const projectedSet = projectNarrowing(lensOrNarrowing);
  const violations: RuleLensViolation[] = [];
  visit(rule, projectedSet, root.mapName, root.model, violations);
  return { ok: violations.length === 0, violations };
};
