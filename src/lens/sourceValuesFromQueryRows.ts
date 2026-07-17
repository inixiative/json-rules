import type { SourceOption } from '../toPrisma/types.ts';
import type { SourceValues } from './projectByPath.ts';
import { accumulateOption, groupsAtPaths, sortOptions } from './sourceOptions.ts';
import type { SourceQuery } from './sourceQuery.ts';

type Row = Record<string, unknown>;

/** Which executor produced the rows — the caller always knows; never guessed. */
export type SourceRowShape = 'prisma' | 'sql';

/**
 * Materialize one compiled `SourceQuery`'s fetched rows into its `SourceValues` —
 * the executor-side counterpart of `sourceQueries`, so apps never hand-map rows.
 * `rowShape` names the wire format: prisma rows (default) nest each `groupBy` axis
 * as related objects; sql rows carry them flat under the statement's `__group_i`
 * aliases. Grouped queries fetch without DISTINCT, so dedup per (groups, value)
 * happens here.
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
    const rawLabel = query.label === undefined ? undefined : row[query.label];
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
