import {
  requiredBindings as conditionRequiredBindings,
  resolveBindings as resolveConditionBindings,
} from '../bindings.ts';
import type { Condition, RuleValue } from '../types.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  NarrowingDefaults,
} from './types.ts';
import { collectChain, isLens } from './walk.ts';

const PARENT_PREFIX = 'parent:';
const isParentRef = (name: string): boolean => name.startsWith(PARENT_PREFIX);
const baseName = (name: string): string =>
  isParentRef(name) ? name.slice(PARENT_PREFIX.length) : name;

// Every Condition a model node carries: its own `where`, each `sources` where,
// and the same recursively for path-specific relations.
const modelNodeConditions = (n: ModelDefaultNarrowing | ModelNarrowing): Condition[] => {
  const out: Condition[] = [];
  if (n.where !== undefined) out.push(n.where);
  for (const w of Object.values(n.sources ?? {})) out.push(w);
  if ('relations' in n && n.relations)
    for (const sub of Object.values(n.relations)) out.push(...modelNodeConditions(sub));
  return out;
};

// Every Condition one narrowing layer carries (root + mapDefaults).
const layerConditions = (nrw: LensNarrowing): Condition[] => {
  const out: Condition[] = [];
  if (nrw.root) out.push(...modelNodeConditions(nrw.root));
  for (const defaults of Object.values(nrw.mapDefaults ?? {}))
    for (const m of Object.values(defaults.models ?? {})) out.push(...modelNodeConditions(m));
  return out;
};

// Bind names a layer *declares* (introduces). `parent:` tokens are inherited
// references, not declarations.
const declaredNames = (nrw: LensNarrowing): Set<string> => {
  const names = new Set<string>();
  for (const cond of layerConditions(nrw))
    for (const name of conditionRequiredBindings(cond)) if (!isParentRef(name)) names.add(name);
  return names;
};

/**
 * Every bind name a lens (its whole narrowing chain) needs supplied to execute.
 * `parent:` references collapse to their base name — the caller supplies one value
 * per name and an inherited reference draws the same one. This is the "what does
 * this lens require" answer; pass `narrowing.parent` to see the names a child must
 * not collide with.
 */
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
    const sources: Record<string, Condition> = {};
    for (const [field, where] of Object.entries(node.sources))
      sources[field] = resolveConditionBindings(where, effective);
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

/**
 * Preprocess a lens: resolve every `{ bind }` token the map covers in the chain's
 * `where`/`sources`, returning a structurally-new lens with concrete conditions.
 * Partial — uncovered tokens stay, so stages bind progressively. Once resolved,
 * `applyLens` / `toPrisma` / `toSql` / `sourceQueries` / `projectByPath` consume the
 * lens unchanged: a bind needs nothing new downstream. `parent:name` draws the same
 * value as the ancestor's `name`. Does not mutate the input.
 */
export const resolveLensBindings = (
  lensOrNarrowing: Lens | LensNarrowing,
  bindings: Record<string, RuleValue>,
): Lens | LensNarrowing => {
  if (isLens(lensOrNarrowing)) return lensOrNarrowing; // a bare lens carries no where/sources
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

/**
 * Bind names are unique across a composed chain: a layer may not re-declare a name
 * an ancestor already declares — rename it, or reference the inherited one read-only
 * as `parent:name`. A `parent:name` reference must point at a name some ancestor
 * actually declares. Returns the violation messages (folded into `validateNarrowing`).
 */
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
