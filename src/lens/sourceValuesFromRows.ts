import { type CheckOptions, check } from '../check.ts';
import type { SourceOption } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { projectByPath, type SourceValues } from './projectByPath.ts';
import { accumulateOption, groupAtPath, sortOptions } from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

type Row = Record<string, unknown>;

// Rows anchored at a projection path: segments after the root model name descend
// relations, flattening to-many arrays (mirrors the joins a SourceQuery would emit).
const rowsAtPath = (rows: readonly Row[], path: string): Row[] => {
  let current: Row[] = [...rows];
  for (const segment of path.split('.').slice(1)) {
    const next: Row[] = [];
    for (const row of current) {
      const value = row?.[segment];
      if (Array.isArray(value)) next.push(...(value as Row[]));
      else if (value != null) next.push(value as Row);
    }
    current = next;
  }
  return current;
};

const composeEligibility = (sourceClauses: Condition[]): Condition => {
  if (sourceClauses.length === 0) return true;
  return sourceClauses.length === 1 ? sourceClauses[0] : { all: sourceClauses };
};

/**
 * Materialize each sourced field's option set from an already-fetched collection —
 * the in-memory executor of `sources` declarations, alongside `sourceQueries`
 * (which compiles the same declarations to DISTINCT queries for a DB). Rows are
 * the collection fetched UNDER the lens (relations inline), so they are already
 * lens-scoped: eligibility here is the field's source `where` only, evaluated via
 * `check()` (`options` feeds `{bind}` clauses). Scalar-list fields contribute one
 * option per element, labels take the first non-null sibling, and sorting is
 * numeric-aware in a fixed locale. Feed the result to `exposedSurface` /
 * `projectByPath` as `{ sourceValues }`.
 */
export const sourceValuesFromRows = (
  lensOrNarrowing: Lens | LensNarrowing,
  rows: readonly Row[],
  options?: CheckOptions,
): SourceValues[] => {
  const out: SourceValues[] = [];

  for (const [path, visit] of projectByPath(lensOrNarrowing)) {
    const sourceFields = Object.entries(visit.sources);
    if (sourceFields.length === 0) continue;

    const anchors = rowsAtPath(rows, path);
    for (const [field, sourceClauses] of sourceFields) {
      const where = composeEligibility(sourceClauses);
      const label = visit.sourceLabels[field];
      const groupBy = visit.sourceGroupBys[field];

      const byKey = new Map<string, SourceOption>();
      for (const row of anchors) {
        if (check(where, row, options) !== true) continue;
        const rawValue = row[field];
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        const rawLabel = label === undefined ? undefined : row[label];
        const rowLabel = rawLabel == null ? undefined : String(rawLabel);
        // Unreachable group path (null hop) → the option stays ungrouped.
        const group = groupBy === undefined ? undefined : groupAtPath(row, groupBy);
        for (const value of values) {
          if (value == null || typeof value === 'object') continue;
          accumulateOption(byKey, String(value), rowLabel, group);
        }
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
