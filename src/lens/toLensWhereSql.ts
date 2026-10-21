import { type WhereSqlDialect, whereSql } from '../toSql/whereSql.ts';
import { allOf } from '../traverse';
import { resolvePolicy, shownVisits } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type LensWhereSqlOptions = {
  /** Path from the lens model → the caller's SQL for that column, used as written: `'name'` at the
   *  root, `'<relation path>.<field>'` below it. */
  columns: Record<string, string>;
  dialect: WhereSqlDialect;
};

export type LensWhereSql = {
  /** The lens model's `where`s, null when it has none. */
  root: string | null;
  /** Each visit below the root that has `where`s — a relation's own, or its model's
   *  `mapDefaults` — keyed by the relation path that reaches it. */
  relations: Record<string, string>;
};

/**
 * A lens's row filters as SQL predicates (see `toWhereSql`), one per visit the lens shows: the
 * root's, and each relation path's — a `mapDefaults` model's `where` reports under every path that
 * reaches the model. A field reads `columns` by its path from the lens model. The rows a relation's
 * `where` filters out are absent in SQL, where check() treats them as hidden.
 */
export const toLensWhereSql = (
  lens: Lens | LensNarrowing,
  { columns, dialect }: LensWhereSqlOptions,
): LensWhereSql => {
  const policy = resolvePolicy(lens);
  let root: string | null = null;
  const relations: [string, string][] = [];
  for (const { at, effect } of shownVisits(policy)) {
    if (!effect.whereClauses.length) continue;
    const prefix = at.relPath.join('.');
    const sql = whereSql(
      allOf(effect.whereClauses),
      { dialect, columns, map: policy.lens, mapName: at.mapName, model: at.modelName },
      prefix ? `${prefix}.` : '',
    );
    if (prefix) relations.push([prefix, sql]);
    else root = sql;
  }
  return { root, relations: Object.fromEntries(relations) };
};
