import { toPrisma } from '../toPrisma/index.ts';
import type { PrismaStep, PrismaWhere } from '../toPrisma/types.ts';
import { buildCondition } from '../toSql/condition.ts';
import { toSql } from '../toSql/index.ts';
import { resolveFieldSql } from '../toSql/join.ts';
import type { BuilderState } from '../toSql/types.ts';
import type { Condition } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { projectByPath } from './projectByPath.ts';
import { groupGuardClauses } from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** Prisma `select` shape — nested for a grouped source's relation path. */
export type SourceSelect = { [field: string]: true | { select: SourceSelect } };

export type SourcePrismaQuery = {
  model: string;
  /** Absent for grouped sources — DISTINCT on the value column alone would collapse
   * same-value rows across groups; dedup happens in `sourceValuesFromQueryRows`. */
  distinct?: string[];
  select: SourceSelect;
  where: PrismaWhere;
  /** Present only if the composed where used count operators (run via executePrismaQueryPlan). */
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
  /** Sibling column co-selected as each value's display label (from a SourceSpec's `label`). */
  label?: string;
  /** Option-partition path (from a SourceSpec's `groupBy`); its column is selected
   * nested in prisma and aliased `__group` in sql. */
  groupBy?: string;
  composedWhere: Condition; // node whereClauses ∧ source where(s)
  prisma: SourcePrismaQuery;
  sql: SourceSqlQuery;
};

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const compose = (whereClauses: Condition[], sourceClauses: Condition[]): Condition => {
  const all = [...whereClauses, ...sourceClauses];
  return all.length === 1 ? all[0] : { all };
};

// 'map.definition.label' → { map: { select: { definition: { select: { label: true } } } } }
const nestedSelect = (path: string[]): SourceSelect =>
  path.length === 1 ? { [path[0]]: true } : { [path[0]]: { select: nestedSelect(path.slice(1)) } };

const compileOne = (
  lens: Lens,
  mapName: string,
  model: string,
  field: string,
  label: string | undefined,
  groupBy: string | undefined,
  where: Condition,
): { prisma: SourcePrismaQuery; sql: SourceSqlQuery } => {
  const plan = toPrisma(where, { map: lens, mapName, model });
  const last = plan.steps[plan.steps.length - 1];
  const prismaWhere = (last && 'where' in last ? last.where : {}) as PrismaWhere;
  const groupBySteps = plan.steps.filter((s) => s.operation !== 'where');
  const select: SourceSelect = {
    [field]: true,
    ...(label ? { [label]: true } : {}),
    ...(groupBy ? nestedSelect(groupBy.split('.')) : {}),
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
    let sql: string;
    let params: unknown[];
    let joins: string[];
    let groupCol: string | undefined;
    if (groupBy) {
      // Build the where and the group column against one state so the group
      // path reuses (and extends) the where's join registry.
      const state: BuilderState = {
        params: [],
        paramIndex: 0,
        map: lens.maps[mapName],
        currentModel: model,
        currentAlias: 't0',
        joinCounter: { n: 0 },
        joins: [],
        joinRegistry: new Map(),
      };
      sql = buildCondition(where, state);
      groupCol = resolveFieldSql(groupBy, state);
      params = state.params;
      joins = state.joins ?? [];
    } else {
      ({ sql, params, joins } = toSql(where, { map: lens.maps[mapName], model, alias: 't0' }));
    }
    const joinSql = joins.length ? ` ${joins.join(' ')}` : '';
    const whereSql = sql?.trim() ? ` WHERE ${sql}` : '';
    const cols = [
      `${q('t0')}.${q(field)}`,
      ...(label ? [`${q('t0')}.${q(label)}`] : []),
      ...(groupCol ? [`${groupCol} AS ${q('__group')}`] : []),
    ].join(', ');
    const statement = `SELECT DISTINCT ${cols} FROM ${q(model)} AS ${q('t0')}${joinSql}${whereSql}`;
    sqlQuery = { sql: statement, params };
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
 * to `sourceValuesFromQueryRows`.
 */
export const sourceQueries = (lensOrNarrowing: Lens | LensNarrowing): SourceQuery[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  const { lens } = policy;
  const projection = projectByPath(lensOrNarrowing);
  const out: SourceQuery[] = [];
  for (const [path, visit] of projection) {
    const relPath = path.split('.').slice(1);
    for (const [field, sourceClauses] of Object.entries(visit.sources)) {
      const label = visit.sourceLabels[field];
      const groupBy = visit.sourceGroupBys[field];
      const groupGuards = groupBy
        ? groupGuardClauses(policy, visit.mapName, visit.modelName, relPath, groupBy)
        : [];
      const composedWhere = compose(visit.whereClauses, [...sourceClauses, ...groupGuards]);
      const { prisma, sql } = compileOne(
        lens,
        visit.mapName,
        visit.modelName,
        field,
        label,
        groupBy,
        composedWhere,
      );
      out.push({
        path,
        mapName: visit.mapName,
        model: visit.modelName,
        field,
        ...(label !== undefined ? { label } : {}),
        ...(groupBy !== undefined ? { groupBy } : {}),
        composedWhere,
        prisma,
        sql,
      });
    }
  }
  return out;
};
