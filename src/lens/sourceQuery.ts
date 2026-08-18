import { toPrisma } from '../toPrisma/index.ts';
import type { PrismaStep, PrismaWhere } from '../toPrisma/types.ts';
import { buildCondition } from '../toSql/condition.ts';
import { toSql } from '../toSql/index.ts';
import { resolveFieldSql } from '../toSql/join.ts';
import type { BuilderState } from '../toSql/types.ts';
import type { Condition } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { projectByPath } from './projectByPath.ts';
import { traversalGuards } from './sourceOptions.ts';
import type { Lens, LensNarrowing } from './types.ts';

// gloss
export type SourceSelect = { [field: string]: true | { select: SourceSelect } };

// gloss
export type SourcePrismaQuery = {
  model: string;
  distinct?: string[];
  select: SourceSelect;
  where: PrismaWhere;
  steps?: PrismaStep[];
};

// gloss
export type SourceSqlQuery = { sql: string | null; params: unknown[]; error?: string };

// gloss
export type SourceQuery = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  label?: string;
  groupBy?: string[];
  composedWhere: Condition;
  prisma: SourcePrismaQuery;
  sql: SourceSqlQuery;
};

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const compose = (whereClauses: Condition[], sourceClauses: Condition[]): Condition => {
  const all = [...whereClauses, ...sourceClauses];
  return all.length === 1 ? all[0] : { all };
};

// gloss
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

// gloss
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
  const select: SourceSelect = {
    [field]: true,
    ...(label ? { [label]: true } : {}),
    ...(groupBy ? nestedSelects(groupBy) : {}),
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
    let groupCols: string[] | undefined;
    if (groupBy) {
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
      groupCols = groupBy.map((axis) => resolveFieldSql(axis, state));
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
      ...(groupCols ? groupCols.map((col, i) => `${col} AS ${q(`__group_${i}`)}`) : []),
    ].join(', ');
    const statement = `SELECT DISTINCT ${cols} FROM ${q(model)} AS ${q('t0')}${joinSql}${whereSql}`;
    sqlQuery = { sql: statement, params };
  } catch (err) {
    sqlQuery = { sql: null, params: [], error: err instanceof Error ? err.message : String(err) };
  }
  return { prisma, sql: sqlQuery };
};

// gloss
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
      const guards = traversalGuards(
        policy,
        visit.mapName,
        visit.modelName,
        relPath,
        groupBy ?? [],
        sourceClauses,
      );
      const composedWhere = compose(visit.whereClauses, [...sourceClauses, ...guards]);
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
