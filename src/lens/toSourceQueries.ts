import { endpointKey } from '../fieldMap/endpointKey';
import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import type { FieldMap } from '../fieldMap/types';
import { walkFieldPath } from '../fieldMap/walk';
import { modelOf, own } from '../own';
import { toPrisma } from '../toPrisma/index.ts';
import type { PrismaStep, PrismaWhere, WhereStep } from '../toPrisma/types.ts';
import { buildCondition } from '../toSql/condition.ts';
import { escapeIdentifier } from '../toSql/escape.ts';
import { builderState } from '../toSql/index.ts';
import { resolveFieldSql } from '../toSql/join.ts';
import type { Condition, DateConfig } from '../types.ts';
import { LensRefusal, resolvePolicy } from './policy.ts';
import { compileOrRefuse } from './prismaRefusal.ts';
import { readPaths } from './readPaths.ts';
import { sourcePlans } from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** Prisma `select` shape — nested for a grouped source's relation path. */
export type SourceSelect = { [field: string]: true | { select: SourceSelect } };

export type SourcePrismaQuery = {
  model: string;
  /** The value column, and a sibling label column: one row per value and label, so the least
   * label is there for `materializeSourceQuery` to pick. Absent for grouped sources and a dotted
   * label — DISTINCT on columns alone would collapse rows across groups or labels; dedup happens
   * in `materializeSourceQuery`. */
  distinct?: string[];
  select: SourceSelect;
  where: PrismaWhere;
  /** Present only if the composed where used count operators (run via executePrismaPlan). */
  steps?: PrismaStep[];
};

/** `sql` is null when the composed where uses a predicate SQL can't express
 * (e.g. array-condition operators); `error` then carries why. Prisma still
 * compiles — run that, or fall back to fetch + `check()`. */
export type SourceSqlQuery = { sql: string | null; params: unknown[]; error?: string };

export type SourceQuery = {
  path: string; // dotted projection path (e.g. 'Region' or 'User.region')
  mapName: string;
  model: string;
  field: string;
  /** Co-selected as each value's display label (from a SourceSpec's `label`): a sibling
   * column, or a dotted to-one path like a groupBy axis — then selected nested in prisma
   * and aliased `__label` in sql. Across a bridge it is not selected: it is read from the far side
   * the caller loads onto each candidate row. */
  label?: string;
  /** Option-partition axes (from a SourceSpec's `groupBy`, normalized); each axis
   * column is selected nested in prisma and aliased `__group_i` in sql — save one across a
   * bridge, read from the far side as a label across one is. */
  groupBy?: string[];
  composedWhere: Condition; // node whereClauses ∧ source where(s)
  prisma: SourcePrismaQuery;
  sql: SourceSqlQuery;
  /** Present when the source reads across a bridge (its where, a grant carried across one, its
   * label or an axis); absent otherwise. **If `recheck` is present, the query's rows are
   * candidates, not options:** a database holds one side of a bridge, so the query folds what
   * reads across it to TRUE and over-fetches — it never misses an option, but may return more.
   * `recheck` is the condition the database couldn't decide (the conjuncts of `composedWhere` that
   * read across a bridge; `true` when only the label or an axis does). The query selects the local
   * columns `recheck` reads and each bridge's local `on` key; load the far side onto each candidate
   * row under its bridge field (the `indexBridges` shape) and pass the rows to
   * `materializeSourceQuery(query, rows, { lens })`, which re-checks them and reads the label and
   * axes across the bridge from the far side. */
  recheck?: Condition;
};

/** What a source query's compile reads besides the lens: the clock, as the compilers take it. */
export type SourceQueryOptions = DateConfig;

// 'map.definition.label' → { map: { select: { definition: { select: { label: true } } } } };
// axes sharing a prefix merge into one nested select tree.
const mergeSelect = (into: SourceSelect, path: string[]): void => {
  const [head, ...rest] = path;
  const existing = into[head];
  if (rest.length === 0) {
    // A relation read for presence keeps the columns already selected under it.
    if (existing === undefined) into[head] = true;
    return;
  }
  const nested = existing !== undefined && existing !== true ? existing.select : {};
  mergeSelect(nested, rest);
  into[head] = { select: nested };
};

// The local column a read across a bridge needs: the near endpoint's `on` key, under the local
// relations the read crosses before the bridge ('org.crm:Account.tier' → 'org.crmId').
const bridgeKey = (lens: Lens, map: FieldMap, mapName: string, model: string, read: string) => {
  const { hops } = walkFieldPath(read, map, model);
  const parts = read.split('.');
  const near = hops.at(-1)?.entry.type ?? model;
  const farKey = parts[hops.length];
  for (const { endpoints } of lens.bridges ?? []) {
    const [a, b] = endpoints;
    for (const [here, there] of [
      [a, b],
      [b, a],
    ])
      if (here.fieldMap === mapName && here.model === near && endpointKey(there) === farKey)
        return [...parts.slice(0, hops.length), here.on].join('.');
  }
  throw new LensRefusal(`'${read}' crosses no bridge the lens declares on ${near}`, 'not_in_lens');
};

const compileOne = (
  lens: Lens,
  path: string,
  mapName: string,
  model: string,
  field: string,
  label: string | undefined,
  groupBy: string[] | undefined,
  where: Condition,
  options: SourceQueryOptions,
  recheck: Condition | undefined,
): { prisma: SourcePrismaQuery; sql: SourceSqlQuery } => {
  // Across a bridge the compilers fold what reads the far side to an over-fetch (`{}` / TRUE): the
  // query returns candidates, and `recheck` decides them over rows holding the far side.
  const plan = compileOrRefuse(`source '${field}' at '${path}'`, () =>
    toPrisma(where, { ...options, map: lens, mapName, model }),
  );
  // A plan ends on its where step.
  const prismaWhere = (plan.steps.at(-1) as WhereStep).where;
  const groupBySteps = plan.steps.filter((s) => s.operation !== 'where');
  const map = resolveFieldMap(lens, mapName, 'toPrisma') as FieldMap;
  const far = (read: string): boolean =>
    recheck !== undefined && walkFieldPath(read, map, model).kind === 'bridge';
  // A label or axis across a bridge is read from the far side; the query selects its local key.
  const localLabel = label !== undefined && !far(label) ? label : undefined;
  const localAxes = (groupBy ?? []).map((axis) => (far(axis) ? undefined : axis));
  // What the re-check reads here: its local columns, and each bridge's local key.
  const recheckReads =
    recheck === undefined
      ? []
      : [
          ...new Set(
            [
              ...readPaths(recheck),
              ...(label !== undefined && localLabel === undefined ? [label] : []),
              ...(groupBy ?? []).filter(far),
            ].map((read) => (far(read) ? bridgeKey(lens, map, mapName, model, read) : read)),
          ),
        ].filter((read) => read !== field);
  // A dotted label materializes exactly like a groupBy axis — same nested select
  // (merged with any axis sharing its prefix), same joined SQL column.
  const labelPath = localLabel?.includes('.') ? localLabel : undefined;
  const nestedPaths = [
    ...localAxes.filter((axis) => axis !== undefined),
    ...(labelPath ? [labelPath] : []),
    ...recheckReads,
  ];
  const select: SourceSelect = {
    [field]: true,
    ...(localLabel && !labelPath ? { [localLabel]: true } : {}),
  };
  for (const read of nestedPaths) mergeSelect(select, read.split('.'));
  const prisma: SourcePrismaQuery = {
    model,
    // Candidates differ in what the re-check reads, so DISTINCT on the value would drop some.
    ...(groupBy || labelPath || recheck !== undefined
      ? {}
      : { distinct: localLabel ? [field, localLabel] : [field] }),
    select,
    where: prismaWhere,
    ...(groupBySteps.length ? { steps: plan.steps } : {}),
  };

  let sqlQuery: SourceSqlQuery;
  try {
    // Flat SQL rows hold a column of the model, not a relation to load a far side onto.
    const nested = recheckReads.find((read) => {
      const walk = walkFieldPath(read, map, model);
      return walk.kind !== 'direct' || walk.hops.length > 0 || walk.entry.kind === 'object';
    });
    if (nested !== undefined)
      throw new Error(
        `the re-check reads '${nested}' through a relation, which flat SQL rows can't hold — run the Prisma query`,
      );
    // The where and the materialized columns resolve against one state, so a label or axis
    // path reuses (and extends) the where's joins.
    const state = builderState({ ...options, map: lens, mapName, model, alias: 't0' });
    const sql = buildCondition(where, state);
    const labelCol = labelPath ? resolveFieldSql(labelPath, state) : undefined;
    const groupCols = localAxes.map((axis, i) =>
      axis === undefined
        ? undefined
        : `${resolveFieldSql(axis, state)} AS ${escapeIdentifier(`__group_${i}`)}`,
    );
    const joins = state.joins ?? [];
    const joinSql = joins.length ? ` ${joins.join(' ')}` : '';
    const whereSql = sql?.trim() ? ` WHERE ${sql}` : '';
    const root = escapeIdentifier('t0');
    const cols = [
      `${root}.${escapeIdentifier(field)}`,
      ...(labelCol
        ? [`${labelCol} AS ${escapeIdentifier('__label')}`]
        : localLabel
          ? [`${root}.${escapeIdentifier(localLabel)}`]
          : []),
      ...groupCols.filter((col) => col !== undefined),
      ...recheckReads.map((read) => `${root}.${escapeIdentifier(read)}`),
    ].join(', ');
    // The table, as the joins name theirs: the model's `dbName` when it has one.
    const table = modelOf(own(lens.maps, mapName), model)?.dbName ?? model;
    const statement = `SELECT DISTINCT ${cols} FROM ${escapeIdentifier(table)} AS ${root}${joinSql}${whereSql}`;
    sqlQuery = { sql: statement, params: state.params };
  } catch (err) {
    sqlQuery = { sql: null, params: [], error: err instanceof Error ? err.message : String(err) };
  }
  return { prisma, sql: sqlQuery };
};

/**
 * Compile a DISTINCT(value) query — Prisma and SQL — per sourced field across
 * the projected lens. The WHERE is the field's composed eligibility: the model's
 * own narrowing at that path, the grants above it carried down the path, its source
 * where(s), the guards of the relations they cross and any allowed values. A
 * `from: 'mapDefaults'` source reads the model's own source and carries no grant from
 * its layer on. The app runs these (with its own client) to materialize each field's
 * option set — feed the fetched rows to `materializeSourceQuery`. `options` is the clock a
 * relative date in the where compiles with (`now` required for one, as for any compile). A
 * source that reads across a bridge gets an over-fetching query and a `recheck` (see
 * `SourceQuery`): its rows are candidates, not options.
 */
export const toSourceQueries = (
  lensOrNarrowing: Lens | LensNarrowing,
  options: SourceQueryOptions = {},
): SourceQuery[] => {
  const { lens } = resolvePolicy(lensOrNarrowing);
  return sourcePlans(lensOrNarrowing).map(
    ({ path, visit, field, label, groupBy, where, recheck }) => {
      const composedWhere = where;
      const { prisma, sql } = compileOne(
        lens,
        path,
        visit.mapName,
        visit.model,
        field,
        label,
        groupBy,
        composedWhere,
        options,
        recheck,
      );
      return {
        path,
        mapName: visit.mapName,
        model: visit.model,
        field,
        ...(label !== undefined ? { label } : {}),
        ...(groupBy !== undefined ? { groupBy } : {}),
        composedWhere,
        prisma,
        sql,
        ...(recheck !== undefined ? { recheck } : {}),
      };
    },
  );
};
