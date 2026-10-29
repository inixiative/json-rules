import { UsageError } from '../errors';
import type { MapVisit } from '../fieldMap/walk';
import { ArrayOperator } from '../operator';
import { own, ownEntry } from '../own';
import {
  type RelationClamps,
  type ToManyRows,
  type WhereSqlOptions,
  whereSql,
} from '../toSql/whereSql.ts';
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
   *  from the lens model in a path `where`, `'<Model>.<relation>'` in a model default. Not read with
   *  `toMany: 'join'`. */
  tables?: Record<string, string>;
  /** What an array rule on a to-many relation reads. `'subquery'` (the default): an `EXISTS` on its
   *  table from `tables`, carrying its clamps. `'join'`: the row the caller's LEFT JOIN brings — the
   *  caller joins every to-many relation the lens shows from the root, ON its keys AND
   *  `relations[path]` AND the related model's `mapDefaults` entry. Only the root's `where` reads
   *  one, with `notEmpty` (`<key> IS NOT NULL`) or one `any` (`(<key> IS NOT NULL AND cond)`), and
   *  only when every clamp in that ON sits in a layer above the `where`'s. */
  toMany?: 'subquery' | 'join';
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

/** How the `where`s of one layer read a to-many relation, by the layer's index in the chain. */
type ToManyAt = (layer: number) => ToManyRows;

/** A visit's `where`s as one predicate, each reading to-many relations as its layer's `toMany`. */
const layeredSql = (
  wheres: LayeredWhere[],
  options: WhereSqlOptions,
  prefix: string,
  toMany: ToManyAt,
): string => {
  const parts = wheres.map(({ where, layer }) => whereSql(where, options, prefix, toMany(layer)));
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
};

/** The root's `where`s on the caller's join (`toMany: 'join'`). The join's ON carries every clamp on
 *  the relation, from every layer, where check() reads a `where` through the layers above its own:
 *  the two agree only when each clamp sits above the `where`'s layer. One joined row stands for the
 *  relation, so two `any`s on it would have to hold on the same row, where check() lets each find
 *  its own — the root reads it with one. */
const rootJoins = (policy: Policy, root: MapVisit): ToManyAt => {
  const readWithAny = new Set<string>();
  return (layer) => ({
    joined: (relationPath, operator) => {
      const { end } = relationHops(policy.lens.maps, root, relationPath);
      if (!end) throw new Error(`toLensWhereSql: '${relationPath}' reaches no relation`);
      const effect = resolveVisit(policy, end.mapName, end.modelName, end.relPath);
      for (const [clamps, what] of [
        [effect.pathWheres, 'its where'],
        [effect.modelWheres, `${end.modelName}'s default where`],
      ] as const) {
        const late = clamps.find((clamp) => clamp.layer >= layer);
        if (late)
          throw new Error(
            `toLensWhereSql: the root where of layer ${layer + 1} reads '${relationPath}' on the caller's join, whose ON carries a clamp of layer ${late.layer + 1} (${what}) — check() reads a where through the clamps of the layers above its own only. Move that clamp into a narrowing above layer ${layer + 1}, or compile with toMany: 'subquery'`,
          );
      }
      if (operator !== ArrayOperator.any) return;
      if (readWithAny.has(relationPath))
        throw new Error(
          `toLensWhereSql: the root reads '${relationPath}' with two any rules — on the caller's join one joined row stands for the relation, so both conditions would have to hold on the same row, where check() lets each find its own. Write one any whose condition says which row, or compile with toMany: 'subquery'`,
        );
      readWithAny.add(relationPath);
    },
  });
};

/** A `where` that sits in an ON on the caller's join (`toMany: 'join'`) reads no to-many relation:
 *  `why` says where it sits. */
const noJoins =
  (where: string, why: string): ToManyAt =>
  () => ({
    joined: (relationPath) => {
      throw new Error(
        `toLensWhereSql: ${where} reads the to-many relation '${relationPath}' — with toMany: 'join' ${why}; only the root's where reads a joined relation`,
      );
    },
  });

export const toLensWhereSql = (
  lens: Lens | LensNarrowing,
  { columns, tables, toMany = 'subquery' }: LensWhereSqlOptions,
): LensWhereSql => {
  if (toMany !== 'subquery' && toMany !== 'join')
    throw new UsageError(
      `toLensWhereSql: toMany '${String(toMany)}' is neither 'subquery' nor 'join'`,
    );
  const policy = resolvePolicy(lens);
  const out: LensWhereSql = { root: null, relations: {}, mapDefaults: {} };
  for (const { at, effect } of shownVisits(policy)) {
    const options = { columns, tables, map: policy.lens, mapName: at.mapName, model: at.modelName };
    const subquery: ToManyAt = (layer) => ({ clamps: clampsFrom(policy, at, layer) });
    for (const { where } of [...effect.pathWheres, ...effect.modelWheres])
      refuseHiddenHops(policy, at, where);
    if (effect.pathWheres.length) {
      const prefix = at.relPath.join('.');
      const reads =
        toMany === 'subquery'
          ? subquery
          : prefix
            ? noJoins(
                `the where at '${prefix}'`,
                "it sits in that relation's join ON, ahead of the joins below it",
              )
            : rootJoins(policy, at);
      const sql = layeredSql(effect.pathWheres, options, prefix ? `${prefix}.` : '', reads);
      if (prefix) out.relations[prefix] = sql;
      else out.root = sql;
    }
    if (effect.modelWheres.length) {
      const byMap = ownEntry(
        out.mapDefaults,
        at.mapName,
        (): LensWhereSql['mapDefaults'][string] => ({ models: {} }),
      );
      const reads =
        toMany === 'subquery'
          ? subquery
          : noJoins(
              `the default where of ${at.modelName}`,
              `it compiles once for every path that reaches ${at.modelName}, and the join exists only where the lens shows the relation`,
            );
      const sql = layeredSql(effect.modelWheres, options, `${at.modelName}.`, reads);
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
