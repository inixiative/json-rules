import { type CheckOptions, check } from '../check.ts';
import { UsageError } from '../errors';
import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import type { SourceOption } from '../fieldMap/types';
import { hitsBridge } from '../fieldMap/walk';
import type { Row } from '../types';
import { requireReads, visitsOnPath } from './materializeSources.ts';
import { resolvePolicy } from './policy.ts';
import type { SourceValues } from './projectPaths.ts';
import { readPaths } from './readPaths.ts';
import { accumulateRow, groupAtPath, groupsAtPaths, sortOptions } from './sourceOptions.ts';
import type { SourceQuery } from './toSourceQueries.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** Which executor produced the rows — the caller always knows; never guessed. */
export type SourceRowShape = 'prisma' | 'sql';

/** `rowShape`: how the rows came back — nested Prisma rows (the default) or flat SQL rows.
 *  `lens`: the lens the query was compiled from, required for a query with a `recheck` — it says
 *  what each far side must hold. The rest is the clock and bindings the re-check runs with. */
export type MaterializeSourceQueryOptions = CheckOptions & {
  rowShape?: SourceRowShape;
  lens?: Lens | LensNarrowing;
};

/**
 * Materialize one compiled `SourceQuery`'s fetched rows into its `SourceValues` —
 * the executor-side counterpart of `toSourceQueries`, so apps never hand-map rows.
 * `rowShape` names the wire format: prisma rows (default) nest each `groupBy` axis
 * (and a dotted `label`) as related objects; sql rows carry them flat under the
 * statement's `__group_i` / `__label` aliases. Grouped queries fetch without
 * DISTINCT, so dedup per (groups, value) happens here.
 *
 * A query with a `recheck` (a source across a bridge) returned candidates: each row must hold the
 * far side inline under its bridge field — one row or a list as the bridge names it, with every
 * key the re-check, the label and the axes read across it — or this throws a `UsageError` rather
 * than offer a wrong set. A candidate offers its value only if `check(recheck, row, options)`
 * holds; a label or axis across the bridge is read from the far side, in either row shape.
 */
export const materializeSourceQuery = (
  query: SourceQuery,
  rows: readonly Row[],
  opts: MaterializeSourceQueryOptions = {},
): SourceValues => {
  const { rowShape = 'prisma', lens, ...checkOptions } = opts;
  const flat = rowShape === 'sql';
  const { recheck } = query;
  let far = (_read: string): boolean => false;
  let admit = (_row: Row): boolean => true;
  if (recheck !== undefined) {
    if (lens === undefined)
      throw new UsageError(
        `materializeSourceQuery: '${query.path}.${query.field}' reads across a bridge — its rows are candidates; pass { lens } with rows holding the far side`,
      );
    const policy = resolvePolicy(lens);
    const visit = visitsOnPath(policy, query.path).at(-1);
    if (!visit || visit.mapName !== query.mapName || visit.modelName !== query.model)
      throw new UsageError(
        `materializeSourceQuery: the lens doesn't reach ${query.mapName}:${query.model} at '${query.path}' — pass the lens the query was compiled from`,
      );
    const map = resolveFieldMap(policy.lens, query.mapName, 'toPrisma');
    far = (read) => map !== undefined && hitsBridge(read, map, query.model);
    const reads = [
      ...readPaths(recheck),
      ...(query.label !== undefined && far(query.label) ? [query.label] : []),
      ...(query.groupBy ?? []).filter(far),
    ];
    const needs =
      'materializeSourceQuery needs candidate rows holding the far side of each bridge the source reads';
    admit = (row) => {
      requireReads(policy, visit, row, query.path, reads, needs);
      return check(recheck, row, checkOptions) === true;
    };
  }
  // Flat SQL rows alias a local dotted label and the local axes; one across a bridge is read from
  // the far side loaded onto the row.
  const labelAt = (row: Row): unknown =>
    query.label === undefined
      ? undefined
      : flat && query.label.includes('.') && !far(query.label)
        ? row.__label
        : groupAtPath(row, query.label);
  const axes = query.groupBy?.map((axis, i) => (flat && !far(axis) ? `__group_${i}` : axis));
  const byKey = new Map<string, SourceOption>();
  for (const row of rows) {
    if (!admit(row)) continue;
    accumulateRow(
      byKey,
      row,
      query.field,
      labelAt(row),
      axes === undefined ? undefined : groupsAtPaths(row, axes),
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
