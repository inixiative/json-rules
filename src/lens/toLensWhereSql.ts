import { own, ownEntry } from '../own';
import { whereSql } from '../toSql/whereSql.ts';
import { allOf } from '../traverse';
import { resolvePolicy, shownVisits } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type LensWhereSqlOptions = {
  /** Field path → the caller's SQL for that column, used as written. A path `where` reads
   *  `'name'` at the root and `'<relation path>.<field>'` below it; a model default reads
   *  `'<Model>.<field>'`. */
  columns: Record<string, string>;
};

/** A lens's `where`s as SQL, each where the lens wrote it. */
export type LensWhereSql = {
  /** The root path's `where`s, null when it has none. */
  root: string | null;
  /** Each relation path's own `where`s, keyed by the path. */
  relations: Record<string, string>;
  /** Each model default's `where`s (`mapDefaults[map].models[model].where`), keyed the same way:
   *  one predicate per model however many paths reach it. */
  mapDefaults: Record<string, { models: Record<string, string> }>;
};

/**
 * A lens's row filters as SQL predicates in the engine's `sql.dialect` (see `toWhereSql`),
 * mirroring the lens: the root's `where`s under `root`, each relation path's under `relations`,
 * and each model default's under `mapDefaults` — each as its layer wrote it, so a parent's clamp
 * on a hop is reported at that hop's path, never inside what a later layer wrote through it. A
 * model default compiles once and reads `columns` by `'<Model>.<field>'`; a path `where` reads
 * them by its path from the lens model. The rows a `where` filters out are absent in SQL, where
 * check() treats them as hidden.
 */
export const toLensWhereSql = (
  lens: Lens | LensNarrowing,
  { columns }: LensWhereSqlOptions,
): LensWhereSql => {
  const policy = resolvePolicy(lens);
  const out: LensWhereSql = { root: null, relations: {}, mapDefaults: {} };
  for (const { at, effect } of shownVisits(policy)) {
    const options = { columns, map: policy.lens, mapName: at.mapName, model: at.modelName };
    if (effect.pathWheres.length) {
      const prefix = at.relPath.join('.');
      const sql = whereSql(allOf(effect.pathWheres), options, prefix ? `${prefix}.` : '');
      if (prefix) out.relations[prefix] = sql;
      else out.root = sql;
    }
    if (effect.modelWheres.length) {
      const byMap = ownEntry(
        out.mapDefaults,
        at.mapName,
        (): LensWhereSql['mapDefaults'][string] => ({ models: {} }),
      );
      if (own(byMap.models, at.modelName) === undefined)
        byMap.models[at.modelName] = whereSql(
          allOf(effect.modelWheres),
          options,
          `${at.modelName}.`,
        );
    }
  }
  return out;
};
