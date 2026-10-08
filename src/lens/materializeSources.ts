import { type CheckOptions, check } from '../check.ts';
import type { SourceOption } from '../fieldMap/types';
import { readOwnPath } from '../scope';
import type { Row } from '../types';
import type { SourceValues } from './projectPaths.ts';
import {
  accumulateRow,
  groupAtPath,
  groupsAtPaths,
  sortOptions,
  sourcePlans,
} from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

// Rows anchored at a projection path: segments after the root model name descend
// relations, flattening to-many arrays (mirrors the joins a SourceQuery would emit).
const rowsAtPath = (rows: readonly Row[], path: string): Row[] => {
  let current: Row[] = [...rows];
  for (const segment of path.split('.').slice(1)) {
    const next: Row[] = [];
    for (const row of current) {
      const value = readOwnPath(row, segment);
      if (Array.isArray(value)) next.push(...(value as Row[]));
      else if (value != null) next.push(value as Row);
    }
    current = next;
  }
  return current;
};

/**
 * Materialize each sourced field's option set from an already-fetched collection —
 * the in-memory executor of `sources` declarations, alongside `toSourceQueries`
 * (which compiles the same declarations to DISTINCT queries for a DB). Rows are
 * the collection the lens fetches — `toLensSelect`'s rows as fetched, or as
 * `projectRows(…, { keepGrantColumns: true })` keeps them (never a viewer's projection, which
 * drops what the eligibility reads). Each row must meet the condition the source query compiles
 * — its visit's grants, its source `where` narrowed as a rule, the grants above it, the guards of
 * the relations its label and axes cross and any allowed values — evaluated with `check()`
 * (`options`: `now`, `bindings`), so it offers what the database does. Scalar-list fields
 * contribute one option per element, a value takes its least label (a sibling column, or a
 * dotted to-one path read through the nested rows), and sorting is
 * numeric-aware in a fixed locale. Feed the result to `projectLens` as `{ sourceValues }`. A
 * `from: 'mapDefaults'` source throws: a fetched collection can't hold unlinked rows.
 */
export const materializeSources = (
  lensOrNarrowing: Lens | LensNarrowing,
  rows: readonly Row[],
  options?: CheckOptions,
): SourceValues[] =>
  sourcePlans(lensOrNarrowing).map(({ path, visit, field, from, label, groupBy, where }) => {
    // A model source offers rows the fetched collection needn't hold (a tag nobody has yet).
    if (from)
      throw new Error(
        `materializeSources: '${path}.${field}' offers its model's own source, which a fetched collection can't hold — query it with toSourceQueries and materializeSourceQuery.`,
      );
    const byKey = new Map<string, SourceOption>();
    for (const row of rowsAtPath(rows, path)) {
      if (check(where, row, options) !== true) continue;
      // A dotted label reads through the same nested rows a groupBy axis does; an
      // unreachable axis (null hop) leaves the option ungrouped, never partial.
      accumulateRow(
        byKey,
        row,
        field,
        label === undefined ? undefined : groupAtPath(row, label),
        groupBy === undefined ? undefined : groupsAtPaths(row, groupBy),
      );
    }
    return {
      path,
      mapName: visit.mapName,
      model: visit.model,
      field,
      options: sortOptions(byKey),
    };
  });
