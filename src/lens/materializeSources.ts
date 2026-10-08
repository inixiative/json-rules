import { type CheckOptions, check } from '../check.ts';
import type { SourceOption } from '../fieldMap/types';
import { readOwnPath } from '../scope';
import { allOf } from '../traverse';
import type { Condition, Row } from '../types';
import { type Policy, relationHops, resolvePolicy, resolveVisit } from './policy.ts';
import type { SourceValues } from './projectPaths.ts';
import { readPaths } from './readPaths.ts';
import {
  accumulateRow,
  groupAtPath,
  groupsAtPaths,
  sortOptions,
  sourcePlansWith,
} from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

// The first segment of each path a condition reads off a row: what the row must hold.
const keysRead = (condition: Condition): string[] =>
  readPaths(condition).map((path) => path.split('.')[0]);

/** A row a viewer's projection cut (or rows that don't hold a bridge's far side): absence is not
 *  NULL — a fetch returns every key it selects — so materializing it would offer the wrong set. */
const lacking = (path: string, key: string): Error =>
  new Error(
    `materializeSources needs fetched or keepGrantColumns rows, not viewer rows: a row at '${path}' lacks '${key}', which its source reads${key.includes(':') ? ' — rows across a bridge must hold the far side inline under its bridge field' : ''}`,
  );

const requireKeys = (row: Row, path: string, keys: readonly string[]): void => {
  for (const key of keys) if (key !== '' && !Object.hasOwn(row, key)) throw lacking(path, key);
};

// The rows a source's path reaches in a fetched tree, each level's grants met on the way down —
// the tree is the path's link, so a hidden row (a to-one one Prisma can't filter, a list one a
// grant reads whole) and everything under it drops out here.
const rowsAtPath = (
  policy: Policy,
  rows: readonly Row[],
  path: string,
  options: CheckOptions | undefined,
): Row[] => {
  const relPath = path.split('.').slice(1);
  const anchor = { mapName: policy.lens.mapName, modelName: policy.lens.model, relPath: [] };
  const levels = [
    anchor,
    ...relationHops(policy.lens.maps, anchor, relPath.join('.')).hops.map((hop) => ({
      mapName: hop.map,
      modelName: hop.model,
      relPath: hop.relPath,
    })),
  ];
  const admitted = (level: number, candidates: readonly Row[]): Row[] => {
    const visit = levels[level];
    const grants = resolveVisit(policy, visit.mapName, visit.modelName, visit.relPath).whereClauses;
    const where = allOf(grants);
    const keys = grants.flatMap(keysRead);
    const at = [policy.lens.model, ...relPath.slice(0, level)].join('.');
    return candidates.filter((row) => {
      requireKeys(row, at, keys);
      return check(where, row, options) === true;
    });
  };
  let current = admitted(0, rows);
  for (const [level, segment] of relPath.entries()) {
    const next: Row[] = [];
    for (const row of current) {
      const value = readOwnPath(row, segment);
      if (Array.isArray(value)) next.push(...(value as Row[]));
      else if (value != null) next.push(value as Row);
    }
    current = admitted(level + 1, next);
  }
  return current;
};

/**
 * Materialize each sourced field's option set from an already-fetched collection —
 * the in-memory executor of `sources` declarations, alongside `toSourceQueries`
 * (which compiles the same declarations to DISTINCT queries for a DB). Rows are
 * the collection the lens fetches — `toLensSelect`'s rows as fetched, or as
 * `projectRows(…, { keepGrantColumns: true })` keeps them; a viewer's projection drops what
 * the sources read, and a row lacking a key a source or a grant on its path reads throws. The
 * path is walked down the rows, each level's grants met, and each row it reaches must meet its
 * visit's grants, its source `where` narrowed as a rule, the guards of the relations its label
 * and axes cross and any allowed values — evaluated with `check()` (`options`: `now`,
 * `bindings`), so it offers what the database does. Scalar-list fields contribute one option per
 * element, a value takes its least label (a sibling column, or a dotted to-one path read through
 * the nested rows), and sorting is numeric-aware in a fixed locale. Feed the result to
 * `projectLens` as `{ sourceValues }`. A source across a bridge is materialized here alone, from
 * rows that hold the far side inline under its bridge field (the fetch selects no bridge); a
 * `from: 'mapDefaults'` source throws unless it crosses one: a fetched collection can't hold
 * unlinked rows.
 */
export const materializeSources = (
  lensOrNarrowing: Lens | LensNarrowing,
  rows: readonly Row[],
  options?: CheckOptions,
): SourceValues[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  return sourcePlansWith(policy).map(
    ({ path, visit, field, from, label, groupBy, rowWhere, bridged }) => {
      // A model source offers rows the fetched collection needn't hold (a tag nobody has yet).
      if (from && bridged === undefined)
        throw new Error(
          `materializeSources: '${path}.${field}' offers its model's own source, which a fetched collection can't hold — query it with toSourceQueries and materializeSourceQuery.`,
        );
      const keys = [
        field,
        ...keysRead(rowWhere),
        ...[...(label === undefined ? [] : [label]), ...(groupBy ?? [])].map(
          (read) => read.split('.')[0],
        ),
      ];
      const byKey = new Map<string, SourceOption>();
      for (const row of rowsAtPath(policy, rows, path, options)) {
        requireKeys(row, path, keys);
        if (check(rowWhere, row, options) !== true) continue;
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
    },
  );
};
