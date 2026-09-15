import type { SourceOption } from '../toPrisma/types.ts';
import type { SourceValues } from './projectByPath.ts';
import { accumulateOption, groupAtPath, groupsAtPaths, sortOptions } from './sourceOptions.ts';
import type { SourceQuery } from './sourceQuery.ts';

type Row = Record<string, unknown>;

/** Which executor produced the rows — the caller always knows; never guessed. */
export type SourceRowShape = 'prisma' | 'sql';

/**
 * Materialize one compiled `SourceQuery`'s fetched rows into its `SourceValues` —
 * the executor-side counterpart of `sourceQueries`, so apps never hand-map rows.
 * `rowShape` names the wire format: prisma rows (default) nest each `groupBy` axis
 * (and a dotted `label`) as related objects; sql rows carry them flat under the
 * statement's `__group_i` / `__label` aliases. Grouped queries fetch without
 * DISTINCT, so dedup per (groups, value) happens here.
 */
export const sourceValuesFromQueryRows = (
  query: SourceQuery,
  rows: readonly Row[],
  opts: { rowShape?: SourceRowShape } = {},
): SourceValues => {
  const rowShape = opts.rowShape ?? 'prisma';
  const byKey = new Map<string, SourceOption>();
  for (const row of rows) {
    const rawValue = row[query.field];
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    // A dotted label rides the same two wire formats the axes do: nested in prisma
    // rows, flat under the statement's `__label` alias in sql rows.
    const rawLabel =
      query.label === undefined
        ? undefined
        : query.label.includes('.')
          ? rowShape === 'sql'
            ? row.__label
            : groupAtPath(row, query.label)
          : row[query.label];
    const label = rawLabel == null ? undefined : String(rawLabel);
    const groups =
      query.groupBy === undefined
        ? undefined
        : groupsAtPaths(
            row,
            rowShape === 'sql' ? query.groupBy.map((_, i) => `__group_${i}`) : query.groupBy,
          );
    for (const value of values) {
      if (value == null || typeof value === 'object') continue;
      accumulateOption(byKey, String(value), label, groups);
    }
  }
  return {
    path: query.path,
    mapName: query.mapName,
    model: query.model,
    field: query.field,
    options: sortOptions(byKey),
  };
};
