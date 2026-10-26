import type { MapVisit } from '../fieldMap/walk';
import { own, ownEntry } from '../own';
import { type RelationClamps, type WhereSqlOptions, whereSql } from '../toSql/whereSql.ts';
import { isRelationNode, visitCondition } from '../traverse';
import type { Condition } from '../types';
import {
  hiddenHop,
  type LayeredWhere,
  type Policy,
  relationHops,
  resolvePolicy,
  resolveVisit,
  shownVisits,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type LensWhereSqlOptions = {
  /** Field path → the caller's SQL for that column, used as written. A path `where` reads
   *  `'name'` at the root and `'<relation path>.<field>'` below it; a model default reads
   *  `'<Model>.<field>'`. */
  columns: Record<string, string>;
  /** To-many relation path → the caller's SQL for its table, as `toWhereSql` reads it: by its path
   *  from the lens model in a path `where`, `'<Model>.<relation>'` in a model default. */
  tables?: Record<string, string>;
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
/** A where as its layer wrote it may read through a relation a later layer hides — check() still
 *  carries that hop's clamps, narrowed in — but the mirror reports a hop's clamps at its own path,
 *  which a hidden hop has none of. Refused rather than reported without them. */
const refuseHiddenHops = (policy: Policy, from: MapVisit, condition: Condition): void => {
  visitCondition<MapVisit>(
    condition,
    (node, at) => {
      if (typeof node.field !== 'string') return undefined;
      const hidden = hiddenHop(policy, at, node.field);
      if (hidden !== null)
        throw new Error(
          `toLensWhereSql: '${node.field}' at ${at.relPath.length ? `'${at.relPath.join('.')}'` : 'the root'} crosses '${hidden}', a relation the lens hides — a hop's clamps are reported at its own path, so a where may only cross hops the lens shows`,
        );
      // An array rule's condition reads its relation's rows: their fields are checked from there.
      return isRelationNode(node)
        ? (relationHops(policy.lens.maps, at, node.field).end ?? false)
        : undefined;
    },
    from,
  );
};

/** The clamps a to-many relation's rows carry for a `where` written in `layer`, read from a visit:
 *  the relation path's own `where`s and its model's default written in the layers above — what
 *  check() reads that `where` through. A layer's clamps narrow the layers after it, never its own
 *  conditions. Each clamp reads its own relations through the layers above its own layer. */
const clampsFrom =
  (policy: Policy, from: MapVisit, layer: number): RelationClamps =>
  (relationPath) => {
    const { end } = relationHops(policy.lens.maps, from, relationPath);
    if (!end) return [];
    const effect = resolveVisit(policy, end.mapName, end.modelName, end.relPath);
    return [...effect.pathWheres, ...effect.modelWheres]
      .filter((clamp) => clamp.layer < layer)
      .map((clamp) => ({ where: clamp.where, clamps: clampsFrom(policy, end, clamp.layer) }));
  };

/** A visit's `where`s as one predicate, each read through the clamps of the layers above its own. */
const layeredSql = (
  policy: Policy,
  at: MapVisit,
  wheres: LayeredWhere[],
  options: WhereSqlOptions,
  prefix: string,
): string => {
  const parts = wheres.map(({ where, layer }) =>
    whereSql(where, options, prefix, clampsFrom(policy, at, layer)),
  );
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
};

export const toLensWhereSql = (
  lens: Lens | LensNarrowing,
  { columns, tables }: LensWhereSqlOptions,
): LensWhereSql => {
  const policy = resolvePolicy(lens);
  const out: LensWhereSql = { root: null, relations: {}, mapDefaults: {} };
  for (const { at, effect } of shownVisits(policy)) {
    const options = { columns, tables, map: policy.lens, mapName: at.mapName, model: at.modelName };
    for (const { where } of [...effect.pathWheres, ...effect.modelWheres])
      refuseHiddenHops(policy, at, where);
    if (effect.pathWheres.length) {
      const prefix = at.relPath.join('.');
      const sql = layeredSql(policy, at, effect.pathWheres, options, prefix ? `${prefix}.` : '');
      if (prefix) out.relations[prefix] = sql;
      else out.root = sql;
    }
    if (effect.modelWheres.length) {
      const byMap = ownEntry(
        out.mapDefaults,
        at.mapName,
        (): LensWhereSql['mapDefaults'][string] => ({ models: {} }),
      );
      const sql = layeredSql(policy, at, effect.modelWheres, options, `${at.modelName}.`);
      const known = own(byMap.models, at.modelName);
      // A subquery carries the clamps of the path it is reached on: one predicate serves them all
      // only when they agree.
      if (known !== undefined && known !== sql)
        throw new Error(
          `toLensWhereSql: the default where of ${at.modelName} reads a to-many relation whose clamps differ between the paths that reach ${at.modelName} — a model default compiles to one predicate for every path`,
        );
      byMap.models[at.modelName] = sql;
    }
  }
  return out;
};
