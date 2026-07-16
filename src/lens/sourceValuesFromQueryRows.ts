import type { SourceOption } from '../toPrisma/types.ts';
import type { SourceValues } from './projectByPath.ts';
import { accumulateOption, groupAtPath, sortOptions } from './sourceOptions.ts';
import type { SourceQuery } from './sourceQuery.ts';

type Row = Record<string, unknown>;

/**
 * Materialize one compiled `SourceQuery`'s fetched rows into its `SourceValues` —
 * the executor-side counterpart of `sourceQueries`, so apps never hand-map rows.
 * Handles both row shapes: prisma rows nest the `groupBy` path as related objects;
 * sql rows carry it flat under the statement's `__group` alias. Grouped queries
 * fetch without DISTINCT, so dedup per (group, value) happens here.
 */
export const sourceValuesFromQueryRows = (
  query: SourceQuery,
  rows: readonly Row[],
): SourceValues => {
  const byKey = new Map<string, SourceOption>();
  for (const row of rows) {
    const rawValue = row[query.field];
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const rawLabel = query.label === undefined ? undefined : row[query.label];
    const label = rawLabel == null ? undefined : String(rawLabel);
    const group =
      query.groupBy === undefined
        ? undefined
        : (groupAtPath(row, query.groupBy) ?? groupAtPath(row, '__group'));
    for (const value of values) {
      if (value == null || typeof value === 'object') continue;
      accumulateOption(byKey, String(value), label, group);
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
