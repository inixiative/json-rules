import type { SourceOption } from '../toPrisma/types.ts';
import type { SourceValues } from './projectByPath.ts';
import { accumulateRow, groupAtPath, groupsAtPaths, sortOptions } from './sourceOptions.ts';
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
    // A dotted label and the axes ride the two wire formats: nested in prisma rows, flat
    // under the statement's `__label` / `__group_i` aliases in sql rows.
    const flat = rowShape === 'sql';
    accumulateRow(
      byKey,
      row,
      query.field,
      query.label === undefined
        ? undefined
        : flat && query.label.includes('.')
          ? row.__label
          : groupAtPath(row, query.label),
      query.groupBy === undefined
        ? undefined
        : groupsAtPaths(row, flat ? query.groupBy.map((_, i) => `__group_${i}`) : query.groupBy),
    );
  }
  return {
    path: query.path,
    mapName: query.mapName,
    model: query.model,
    field: query.field,
    options: sortOptions(byKey),
  };
};
