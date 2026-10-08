import type { Condition } from '../types.ts';
import { isLens } from './chain.ts';
import { normalizeSource } from './policy.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  NarrowingDefaults,
  SourceEntry,
} from './types.ts';

type Clamps = Pick<ModelDefaultNarrowing, 'where' | 'sources'>;

/** Clamps for {@link clampLens}: a `root` where, and per-map model-default wheres and
 *  source wheres. */
export type LensClamps = {
  root?: Pick<ModelDefaultNarrowing, 'where'>;
  mapDefaults?: Record<string, { models: Record<string, Clamps> }>;
};

const both = (a?: Condition, b?: Condition): Condition | undefined =>
  a === undefined ? b : b === undefined ? a : { all: [a, b] };

const mergeSources = (
  a: ModelDefaultNarrowing['sources'],
  b: ModelDefaultNarrowing['sources'],
): ModelDefaultNarrowing['sources'] => {
  if (!a || !b) return a ?? b;
  const out: Record<string, SourceEntry> = { ...a };
  for (const [field, entry] of Object.entries(b)) {
    const prior = out[field];
    if (prior === undefined) {
      out[field] = entry;
      continue;
    }
    const left = normalizeSource(prior);
    const right = normalizeSource(entry);
    const where = both(left.where, right.where);
    out[field] = { ...left, ...right, ...(where === undefined ? {} : { where }) } as SourceEntry;
  }
  return out;
};

const withClamps = <N extends ModelDefaultNarrowing>(
  narrowing: N | undefined,
  clamps: Clamps,
): N => {
  const where = both(narrowing?.where, clamps.where);
  const sources = mergeSources(narrowing?.sources, clamps.sources);
  return {
    ...narrowing,
    ...(where === undefined ? {} : { where }),
    ...(sources ? { sources } : {}),
  } as N;
};

const mergeDefaults = (
  defaults: NarrowingDefaults | undefined,
  clamps: Record<string, Clamps>,
): NarrowingDefaults => {
  const models: Record<string, ModelDefaultNarrowing> = { ...defaults?.models };
  for (const [model, modelClamps] of Object.entries(clamps))
    models[model] = withClamps(models[model], modelClamps);
  return { ...defaults, models };
};

const clampFirstLayer = (layer: LensNarrowing, clamps: LensClamps): LensNarrowing => {
  const mapDefaults: NonNullable<LensNarrowing['mapDefaults']> = { ...layer.mapDefaults };
  for (const [mapName, { models }] of Object.entries(clamps.mapDefaults ?? {}))
    mapDefaults[mapName] = mergeDefaults(mapDefaults[mapName], models);
  return {
    ...layer,
    ...(clamps.root ? { root: withClamps(layer.root, clamps.root) } : {}),
    ...(clamps.mapDefaults ? { mapDefaults } : {}),
  };
};

/**
 * The lens with `clamps` ANDed into its first narrowing over the base lens (one is added over a
 * bare lens). A clamp that reads what a later layer hides belongs there: only the first layer's
 * clamps read the whole schema. A `where` ANDs with the one in place; a source's `where` ANDs
 * and its `label` / `groupBy` win. Wheres only narrow; a source clamp can add an option set for
 * a field, or relabel or regroup one, but never widens what rows or columns the lens shows.
 */
export const clampLens = (lens: Lens | LensNarrowing, clamps: LensClamps): LensNarrowing => {
  if (isLens(lens)) return clampFirstLayer({ parent: lens }, clamps);
  if (isLens(lens.parent)) return clampFirstLayer(lens, clamps);
  return { ...lens, parent: clampLens(lens.parent, clamps) };
};
