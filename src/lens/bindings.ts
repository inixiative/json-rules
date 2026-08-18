import {
  requiredBindings as conditionRequiredBindings,
  resolveBindings as resolveConditionBindings,
} from '../bindings.ts';
import type { Condition, RuleValue } from '../types.ts';
import { isSourceSpec, normalizeSource } from './policy.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  NarrowingDefaults,
  SourceValue,
} from './types.ts';
import { collectChain, isLens } from './walk.ts';

const PARENT_PREFIX = 'parent:';
const isParentRef = (name: string): boolean => name.startsWith(PARENT_PREFIX);
const baseName = (name: string): string =>
  isParentRef(name) ? name.slice(PARENT_PREFIX.length) : name;

// gloss
const modelNodeConditions = (n: ModelDefaultNarrowing | ModelNarrowing): Condition[] => {
  const out: Condition[] = [];
  if (n.where !== undefined) out.push(n.where);
  for (const entry of Object.values(n.sources ?? {})) {
    const where = normalizeSource(entry).where;
    if (where !== undefined) out.push(where);
  }
  if ('relations' in n && n.relations)
    for (const sub of Object.values(n.relations)) out.push(...modelNodeConditions(sub));
  return out;
};

// gloss
const layerConditions = (nrw: LensNarrowing): Condition[] => {
  const out: Condition[] = [];
  if (nrw.root) out.push(...modelNodeConditions(nrw.root));
  for (const defaults of Object.values(nrw.mapDefaults ?? {}))
    for (const m of Object.values(defaults.models ?? {})) out.push(...modelNodeConditions(m));
  return out;
};

// gloss
const declaredNames = (nrw: LensNarrowing): Set<string> => {
  const names = new Set<string>();
  for (const cond of layerConditions(nrw))
    for (const name of conditionRequiredBindings(cond)) if (!isParentRef(name)) names.add(name);
  return names;
};

// gloss
export const lensRequiredBindings = (lensOrNarrowing: Lens | LensNarrowing): Set<string> => {
  const names = new Set<string>();
  for (const nrw of collectChain(lensOrNarrowing))
    for (const cond of layerConditions(nrw))
      for (const name of conditionRequiredBindings(cond)) names.add(baseName(name));
  return names;
};

const resolveModelNode = <T extends ModelDefaultNarrowing | ModelNarrowing>(
  node: T,
  effective: Record<string, RuleValue>,
): T => {
  const out = { ...node } as ModelNarrowing;
  if (node.where !== undefined) out.where = resolveConditionBindings(node.where, effective);
  if (node.sources) {
    const sources: Record<string, SourceValue> = {};
    for (const [field, entry] of Object.entries(node.sources)) {
      if (isSourceSpec(entry)) {
        sources[field] =
          entry.where !== undefined
            ? { ...entry, where: resolveConditionBindings(entry.where, effective) }
            : entry;
      } else {
        sources[field] = resolveConditionBindings(entry, effective);
      }
    }
    out.sources = sources;
  }
  if ('relations' in node && node.relations) {
    const relations: Record<string, ModelNarrowing> = {};
    for (const [rel, sub] of Object.entries(node.relations))
      relations[rel] = resolveModelNode(sub, effective);
    out.relations = relations;
  }
  return out as T;
};

const resolveMapDefaults = (
  mapDefaults: Record<string, NarrowingDefaults>,
  effective: Record<string, RuleValue>,
): Record<string, NarrowingDefaults> => {
  const out: Record<string, NarrowingDefaults> = {};
  for (const [mapName, defaults] of Object.entries(mapDefaults)) {
    const next: NarrowingDefaults = { ...defaults };
    if (defaults.models) {
      const models: Record<string, ModelDefaultNarrowing> = {};
      for (const [model, node] of Object.entries(defaults.models))
        models[model] = resolveModelNode(node, effective);
      next.models = models;
    }
    out[mapName] = next;
  }
  return out;
};

// gloss
export const resolveLensBindings = (
  lensOrNarrowing: Lens | LensNarrowing,
  bindings: Record<string, RuleValue>,
): Lens | LensNarrowing => {
  if (isLens(lensOrNarrowing)) return lensOrNarrowing;
  const effective: Record<string, RuleValue> = { ...bindings };
  for (const [k, v] of Object.entries(bindings)) effective[`${PARENT_PREFIX}${k}`] = v;
  return {
    ...lensOrNarrowing,
    parent: resolveLensBindings(lensOrNarrowing.parent, bindings),
    root: lensOrNarrowing.root ? resolveModelNode(lensOrNarrowing.root, effective) : undefined,
    mapDefaults: lensOrNarrowing.mapDefaults
      ? resolveMapDefaults(lensOrNarrowing.mapDefaults, effective)
      : undefined,
  };
};

// gloss
export const validateBindNames = (narrowing: LensNarrowing): string[] => {
  const errors: string[] = [];
  const occupied = new Set<string>();
  for (const anc of collectChain(narrowing.parent))
    for (const n of declaredNames(anc)) occupied.add(n);

  for (const n of declaredNames(narrowing)) {
    if (occupied.has(n))
      errors.push(
        `bind name '${n}' already declared by an ancestor narrowing — rename it, or reference the inherited one as 'parent:${n}'`,
      );
  }

  const refs = new Set<string>();
  for (const cond of layerConditions(narrowing))
    for (const name of conditionRequiredBindings(cond))
      if (isParentRef(name)) refs.add(baseName(name));
  for (const r of refs)
    if (!occupied.has(r))
      errors.push(`bind 'parent:${r}' references an inherited binding no ancestor declares`);

  return errors;
};
