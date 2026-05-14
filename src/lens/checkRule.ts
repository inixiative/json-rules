import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types';
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
    throw new Error('checkRuleAgainstLens: lens.mapName required when map is a FieldMapSet');
  }
  return { mapName: lens.mapName, modelName: lens.model };
};

const resolvePathTerminal = (
  set: FieldMapSet,
  startMap: string,
  startModel: string,
  path: string,
): FieldMapEntry | null => {
  const parts = path.split('.');
  let mapName = startMap;
  let modelName = startModel;
  for (let i = 0; i < parts.length; i++) {
    const model: FieldMap[string] | undefined = set[mapName]?.[modelName];
    if (!model) return null;
    const entry = model.fields[parts[i]];
    if (!entry) return null;
    if (i === parts.length - 1) return entry;
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

const collectRuleFields = (condition: Condition, out: string[]): void => {
  if (typeof condition === 'boolean') return;
  if ('all' in condition) {
    for (const c of condition.all) collectRuleFields(c, out);
    return;
  }
  if ('any' in condition) {
    for (const c of condition.any) collectRuleFields(c, out);
    return;
  }
  if ('if' in condition) {
    collectRuleFields(condition.if, out);
    collectRuleFields(condition.then, out);
    if (condition.else !== undefined) collectRuleFields(condition.else, out);
    return;
  }
  if ('field' in condition && typeof condition.field === 'string') {
    out.push(condition.field);
  }
  if ('condition' in condition && condition.condition !== undefined) {
    collectRuleFields(condition.condition, out);
  }
};

export type RuleLensViolation = {
  path: string;
  reason: string;
};

export type RuleLensCheck = {
  ok: boolean;
  violations: RuleLensViolation[];
};

export const checkRuleAgainstLens = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): RuleLensCheck => {
  const root = getRoot(lensOrNarrowing);
  const anchor = resolveAnchor(root);
  const projectedSet = projectNarrowing(lensOrNarrowing);

  const paths: string[] = [];
  collectRuleFields(rule, paths);

  const violations: RuleLensViolation[] = [];
  for (const path of paths) {
    const entry = resolvePathTerminal(projectedSet, anchor.mapName, anchor.modelName, path);
    if (!entry) {
      violations.push({ path, reason: 'path does not resolve through the narrowed lens' });
    }
  }

  return { ok: violations.length === 0, violations };
};
