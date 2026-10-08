import { type CheckOptions, check } from '../check.ts';
import { UsageError } from '../errors';
import type { SourceOption } from '../fieldMap/types';
import { type MapVisit, walkMaps } from '../fieldMap/walk';
import { readOwnPath } from '../scope';
import { allOf } from '../traverse';
import type { Row } from '../types';
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

/** A row a viewer's projection cut (or rows that don't hold a bridge's far side): absence is not
 *  NULL — a fetch returns every key it selects — so materializing it would offer the wrong set. */
const usage = (path: string, problem: string): UsageError =>
  new UsageError(
    `materializeSources needs fetched or keepGrantColumns rows, not viewer rows: a row at '${path}' ${problem}${problem.includes(':') ? ' — rows across a bridge hold the far side inline under its bridge field' : ''}`,
  );

/** Every key each read walks on a row: each relation on the way — one row, or each element of a
 *  list; none past a null one or an empty list — and the column it ends on (a Json column's
 *  inside is the value's own). */
const requireReads = (
  policy: Policy,
  at: MapVisit,
  row: Row,
  path: string,
  reads: readonly string[],
): void => {
  for (const read of reads) {
    let holders: unknown[] = [row];
    for (const { index, field, entry, next } of walkMaps(policy.lens.maps, at, read)) {
      if (!entry) break;
      const walked = read
        .split('.')
        .slice(0, index + 1)
        .join('.');
      const below: unknown[] = [];
      for (const holder of holders) {
        if (holder === null || typeof holder !== 'object') continue;
        if (!Object.hasOwn(holder, field))
          throw usage(path, `lacks '${walked}', which a read needs`);
        const value = (holder as Row)[field];
        // A to-one row is null with its key set only where a viewer's projection hid it.
        if (
          next &&
          (value === null || value === undefined) &&
          entry.fromFields?.some((key) => {
            const fk = (holder as Row)[key];
            return fk !== null && fk !== undefined;
          })
        )
          throw usage(path, `'${walked}' is null while its key is set — a projection hid the row`);
        if (!next || value === null || value === undefined) continue;
        if (Array.isArray(value) !== (entry.isList === true))
          throw usage(
            path,
            `'${walked}' holds ${Array.isArray(value) ? 'a list where it names one row' : 'one row where it names a list'}`,
          );
        below.push(...(Array.isArray(value) ? value : [value]));
      }
      if (!next) break;
      holders = below;
    }
  }
};

// The rows a source's path reaches in a fetched tree, each level's grants met on the way down —
// the tree is the path's link, so a hidden row (a to-one one Prisma can't filter, a list one a
// grant reads whole) and everything under it drops out here.
const rowsAtPath = (
  policy: Policy,
  rows: readonly Row[],
  path: string,
  options: CheckOptions | undefined,
): { rows: Row[]; visit: MapVisit } => {
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
    const reads = grants.flatMap(readPaths);
    const at = [policy.lens.model, ...relPath.slice(0, level)].join('.');
    return candidates.filter((row) => {
      requireReads(policy, visit, row, at, reads);
      return check(where, row, options) === true;
    });
  };
  let current = admitted(0, rows);
  for (const [level, segment] of relPath.entries()) {
    const next: Row[] = [];
    const at = [policy.lens.model, ...relPath.slice(0, level)].join('.');
    for (const row of current) {
      // The path's own relation is a read too: present, and one row or a list as declared.
      requireReads(policy, levels[level], row, at, [segment]);
      const value = readOwnPath(row, segment);
      if (Array.isArray(value)) next.push(...(value as Row[]));
      else if (value != null) next.push(value as Row);
    }
    current = admitted(level + 1, next);
  }
  return { rows: current, visit: levels[levels.length - 1] };
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
        throw new UsageError(
          `materializeSources: '${path}.${field}' offers its model's own source, which a fetched collection can't hold — query it with toSourceQueries and materializeSourceQuery.`,
        );
      const reads = [
        field,
        ...readPaths(rowWhere),
        ...(label === undefined ? [] : [label]),
        ...(groupBy ?? []),
      ];
      const byKey = new Map<string, SourceOption>();
      const reached = rowsAtPath(policy, rows, path, options);
      for (const row of reached.rows) {
        requireReads(policy, reached.visit, row, path, reads);
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
