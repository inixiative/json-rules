import { type CheckOptions, check } from '../check.ts';
import { readOwnPath } from '../scope';
import type { SourceOption } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { allOf, resolvePolicy } from './policy.ts';
import { projectByPath, type SourceValues } from './projectByPath.ts';
import {
  accumulateRow,
  groupAtPath,
  groupsAtPaths,
  sortOptions,
  traversalGuards,
} from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

type Row = Record<string, unknown>;

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
 * the in-memory executor of `sources` declarations, alongside `sourceQueries`
 * (which compiles the same declarations to DISTINCT queries for a DB). Rows are
 * the collection fetched UNDER the lens (relations inline), so they are already
 * lens-scoped: eligibility here is the field's source `where` only, evaluated via
 * `check()` (`options` feeds `{bind}` clauses). Scalar-list fields contribute one
 * option per element, labels take the first non-null value of the label column
 * (a sibling, or a dotted to-one path read through the nested rows), and sorting is
 * numeric-aware in a fixed locale. Feed the result to `exposedSurface` /
 * `projectByPath` as `{ sourceValues }`.
 */
export const sourceValuesFromRows = (
  lensOrNarrowing: Lens | LensNarrowing,
  rows: readonly Row[],
  options?: CheckOptions,
): SourceValues[] => {
  const out: SourceValues[] = [];

  const policy = resolvePolicy(lensOrNarrowing);
  for (const [path, visit] of projectByPath(lensOrNarrowing)) {
    const sourceFields = Object.entries(visit.sources);
    if (sourceFields.length === 0) continue;

    const anchors = rowsAtPath(rows, path);
    const relPath = path.split('.').slice(1);
    for (const [field, sourceClauses] of sourceFields) {
      const label = visit.sourceLabels[field];
      const groupBy = visit.sourceGroupBys[field];
      const guards = traversalGuards(
        policy,
        visit.mapName,
        visit.modelName,
        relPath,
        groupBy ?? [],
        sourceClauses,
        label,
      );
      const where = allOf([...sourceClauses, ...guards]);

      const byKey = new Map<string, SourceOption>();
      for (const row of anchors) {
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

      out.push({
        path,
        mapName: visit.mapName,
        model: visit.modelName,
        field,
        options: sortOptions(byKey),
      });
    }
  }

  return out;
};
