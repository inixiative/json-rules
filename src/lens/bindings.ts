import { bindRule, listBindings } from '../bindings.ts';
import type { Condition, RuleValue } from '../types.ts';
import { collectChain, isLens } from './chain.ts';
import { isSourceSpec } from './policy.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  NarrowingDefaults,
  SourceEntry,
} from './types.ts';

const PARENT_PREFIX = 'parent:';
const isParentRef = (name: string): boolean => name.startsWith(PARENT_PREFIX);
const baseName = (name: string): string =>
  isParentRef(name) ? name.slice(PARENT_PREFIX.length) : name;

type Rewrite = (condition: Condition) => Condition;

// A model node's condition slots — its `where`, each source's `where`, and the same through its
// path relations — listed once. `fn` rewrites each; collecting is a rewrite that keeps them.
const mapNodeConditions = <T extends ModelDefaultNarrowing | ModelNarrowing>(
  node: T,
  fn: Rewrite,
): T => {
  const out = { ...node } as ModelNarrowing;
  if (node.where !== undefined) out.where = fn(node.where);
  if (node.sources) {
    const sources: Record<string, SourceEntry> = {};
    for (const [field, entry] of Object.entries(node.sources))
      sources[field] = isSourceSpec(entry)
        ? entry.where !== undefined
          ? { ...entry, where: fn(entry.where) }
          : entry
        : fn(entry);
    out.sources = sources;
  }
  if ('relations' in node && node.relations) {
    const relations: Record<string, ModelNarrowing> = {};
    for (const [rel, sub] of Object.entries(node.relations))
      relations[rel] = mapNodeConditions(sub, fn);
    out.relations = relations;
  }
  return out as T;
};

// One narrowing layer's condition slots: its root and every map default's models.
const mapLayerConditions = (nrw: LensNarrowing, fn: Rewrite): LensNarrowing => {
  const mapDefaults: Record<string, NarrowingDefaults> = {};
  for (const [mapName, defaults] of Object.entries(nrw.mapDefaults ?? {})) {
    const models: Record<string, ModelDefaultNarrowing> = {};
    for (const [model, node] of Object.entries(defaults.models ?? {}))
      models[model] = mapNodeConditions(node, fn);
    mapDefaults[mapName] = defaults.models ? { ...defaults, models } : defaults;
  }
  return {
    ...nrw,
    root: nrw.root ? mapNodeConditions(nrw.root, fn) : undefined,
    mapDefaults: nrw.mapDefaults ? mapDefaults : undefined,
  };
};

const layerConditions = (nrw: LensNarrowing): Condition[] => {
  const out: Condition[] = [];
  mapLayerConditions(nrw, (condition) => {
    out.push(condition);
    return condition;
  });
  return out;
};

// Bind names a layer *declares* (introduces). `parent:` tokens are inherited
// references, not declarations.
const declaredNames = (nrw: LensNarrowing): Set<string> => {
  const names = new Set<string>();
  for (const cond of layerConditions(nrw))
    for (const name of listBindings(cond)) if (!isParentRef(name)) names.add(name);
  return names;
};

/**
 * Every bind name a lens (its whole narrowing chain) needs supplied to execute —
 * `bindOptional` tokens are not required (unsupplied, they resolve to null).
 * `parent:` references collapse to their base name — the caller supplies one value
 * per name and an inherited reference draws the same one. This is the "what does
 * this lens require" answer; pass `narrowing.parent` to see the names a child must
 * not collide with.
 */
export const listLensBindings = (lensOrNarrowing: Lens | LensNarrowing): string[] => {
  const names = new Set<string>();
  for (const nrw of collectChain(lensOrNarrowing))
    for (const cond of layerConditions(nrw))
      for (const name of listBindings(cond, { required: true })) names.add(baseName(name));
  return [...names].sort();
};

/**
 * Preprocess a lens: resolve every `{ bind }` token the map covers in the chain's
 * `where`/`sources`, returning a structurally-new lens with concrete conditions.
 * Partial — uncovered tokens stay, so stages bind progressively. Once resolved,
 * `narrowRule` / `toPrisma` / `toSql` / `toSourceQueries` / `projectPaths` consume the
 * lens unchanged: a bind needs nothing new downstream. `parent:name` draws the same
 * value as the ancestor's `name`. Does not mutate the input.
 */
export const bindLens = (
  lensOrNarrowing: Lens | LensNarrowing,
  bindings: Record<string, RuleValue>,
): Lens | LensNarrowing => {
  if (isLens(lensOrNarrowing)) return lensOrNarrowing; // a bare lens carries no where/sources
  const effective: Record<string, RuleValue> = { ...bindings };
  for (const [k, v] of Object.entries(bindings)) effective[`${PARENT_PREFIX}${k}`] = v;
  return {
    ...mapLayerConditions(lensOrNarrowing, (condition) => bindRule(condition, effective)),
    parent: bindLens(lensOrNarrowing.parent, bindings),
  };
};

/**
 * Bind names are unique across a composed chain: a layer may not re-declare a name
 * an ancestor already declares — rename it, or reference the inherited one read-only
 * as `parent:name`. A `parent:name` reference must point at a name some ancestor
 * actually declares. Returns the problems as messages (folded into `validateNarrowing`).
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
    for (const name of listBindings(cond)) if (isParentRef(name)) refs.add(baseName(name));
  for (const r of refs)
    if (!occupied.has(r))
      errors.push(`bind 'parent:${r}' references an inherited binding no ancestor declares`);

  return errors;
};
