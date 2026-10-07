import { own } from '../own';
import { toPrisma } from '../toPrisma/index.ts';
import type { PrismaStep, PrismaWhere } from '../toPrisma/types.ts';
import { buildCondition } from '../toSql/condition.ts';
import { escapeIdentifier } from '../toSql/escape.ts';
import { builderState } from '../toSql/index.ts';
import { resolveFieldSql } from '../toSql/join.ts';
import { allOf } from '../traverse';
import type { Condition } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { sourcePlans } from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** Prisma `select` shape — nested for a grouped source's relation path. */
export type SourceSelect = { [field: string]: true | { select: SourceSelect } };

export type SourcePrismaQuery = {
  model: string;
  /** Absent for grouped sources — DISTINCT on the value column alone would collapse
   * same-value rows across groups; dedup happens in `materializeSourceQuery`. */
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
   * and aliased `__label` in sql. */
  label?: string;
  /** Option-partition axes (from a SourceSpec's `groupBy`, normalized); each axis
   * column is selected nested in prisma and aliased `__group_i` in sql. */
  groupBy?: string[];
  composedWhere: Condition; // node whereClauses ∧ source where(s)
  prisma: SourcePrismaQuery;
  sql: SourceSqlQuery;
};

// 'map.definition.label' → { map: { select: { definition: { select: { label: true } } } } };
// axes sharing a prefix merge into one nested select tree.
const mergeSelect = (into: SourceSelect, path: string[]): void => {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    into[head] = true;
    return;
  }
  const existing = into[head];
  const nested = existing !== undefined && existing !== true ? existing.select : {};
  mergeSelect(nested, rest);
  into[head] = { select: nested };
};
const nestedSelects = (paths: readonly string[]): SourceSelect => {
  const out: SourceSelect = {};
  for (const path of paths) mergeSelect(out, path.split('.'));
  return out;
};

const compileOne = (
  lens: Lens,
  mapName: string,
  model: string,
  field: string,
  label: string | undefined,
  groupBy: string[] | undefined,
  where: Condition,
): { prisma: SourcePrismaQuery; sql: SourceSqlQuery } => {
  const plan = toPrisma(where, { map: lens, mapName, model });
  const last = plan.steps[plan.steps.length - 1];
  const prismaWhere = (last && 'where' in last ? last.where : {}) as PrismaWhere;
  const groupBySteps = plan.steps.filter((s) => s.operation !== 'where');
  // A dotted label materializes exactly like a groupBy axis — same nested select
  // (merged with any axis sharing its prefix), same joined SQL column.
  const labelPath = label?.includes('.') ? label : undefined;
  const nestedPaths = [...(groupBy ?? []), ...(labelPath ? [labelPath] : [])];
  const select: SourceSelect = {
    [field]: true,
    ...(label && !labelPath ? { [label]: true } : {}),
    ...(nestedPaths.length ? nestedSelects(nestedPaths) : {}),
  };
  const prisma: SourcePrismaQuery = {
    model,
    ...(groupBy ? {} : { distinct: [field] }),
    select,
    where: prismaWhere,
    ...(groupBySteps.length ? { steps: plan.steps } : {}),
  };

  let sqlQuery: SourceSqlQuery;
  try {
    // The where and the materialized columns resolve against one state, so a label or axis
    // path reuses (and extends) the where's joins.
    const state = builderState({ map: own(lens.maps, mapName), model, alias: 't0' });
    const sql = buildCondition(where, state);
    const labelCol = labelPath ? resolveFieldSql(labelPath, state) : undefined;
    const groupCols = groupBy?.map((axis) => resolveFieldSql(axis, state));
    const joins = state.joins ?? [];
    const joinSql = joins.length ? ` ${joins.join(' ')}` : '';
    const whereSql = sql?.trim() ? ` WHERE ${sql}` : '';
    const root = escapeIdentifier('t0');
    const cols = [
      `${root}.${escapeIdentifier(field)}`,
      ...(labelCol
        ? [`${labelCol} AS ${escapeIdentifier('__label')}`]
        : label
          ? [`${root}.${escapeIdentifier(label)}`]
          : []),
      ...(groupCols
        ? groupCols.map((col, i) => `${col} AS ${escapeIdentifier(`__group_${i}`)}`)
        : []),
    ].join(', ');
    const statement = `SELECT DISTINCT ${cols} FROM ${escapeIdentifier(model)} AS ${root}${joinSql}${whereSql}`;
    sqlQuery = { sql: statement, params: state.params };
  } catch (err) {
    sqlQuery = { sql: null, params: [], error: err instanceof Error ? err.message : String(err) };
  }
  return { prisma, sql: sqlQuery };
};

/**
 * Compile a DISTINCT(value) query — Prisma and SQL — per sourced field across
 * the projected lens. The WHERE is the field's composed eligibility: the model's
 * own narrowing at that path AND its source where(s). The app runs these (with
 * its own client) to materialize each field's option set — feed the fetched rows
 * to `materializeSourceQuery`.
 */
export const toSourceQueries = (lensOrNarrowing: Lens | LensNarrowing): SourceQuery[] => {
  const { lens } = resolvePolicy(lensOrNarrowing);
  return sourcePlans(lensOrNarrowing).map(({ path, visit, field, label, groupBy, eligibility }) => {
    const composedWhere = allOf([...visit.whereClauses, ...eligibility]);
    const { prisma, sql } = compileOne(
      lens,
      visit.mapName,
      visit.model,
      field,
      label,
      groupBy,
      composedWhere,
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
    };
  });
};
