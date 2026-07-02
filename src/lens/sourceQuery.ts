import { toPrisma } from '../toPrisma/index.ts';
import type { PrismaStep, PrismaWhere } from '../toPrisma/types.ts';
import { toSql } from '../toSql/index.ts';
import type { Condition } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { projectByPath } from './projectByPath.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type SourcePrismaQuery = {
  model: string;
  distinct: string[];
  select: Record<string, true>;
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
  composedWhere: Condition; // node whereClauses ∧ source where(s)
  prisma: SourcePrismaQuery;
  sql: SourceSqlQuery;
};

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

const compose = (whereClauses: Condition[], sourceClauses: Condition[]): Condition => {
  const all = [...whereClauses, ...sourceClauses];
  return all.length === 1 ? all[0] : { all };
};

const compileOne = (
  lens: Lens,
  mapName: string,
  model: string,
  field: string,
  label: string | undefined,
  where: Condition,
): { prisma: SourcePrismaQuery; sql: SourceSqlQuery } => {
  const plan = toPrisma(where, { map: lens, mapName, model });
  const last = plan.steps[plan.steps.length - 1];
  const prismaWhere = (last && 'where' in last ? last.where : {}) as PrismaWhere;
  const groupBySteps = plan.steps.filter((s) => s.operation !== 'where');
  const select: Record<string, true> = label ? { [field]: true, [label]: true } : { [field]: true };
  const prisma: SourcePrismaQuery = {
    model,
    distinct: [field],
    select,
    where: prismaWhere,
    ...(groupBySteps.length ? { steps: plan.steps } : {}),
  };

  let sqlQuery: SourceSqlQuery;
  try {
    const { sql, params, joins } = toSql(where, { map: lens.maps[mapName], model, alias: 't0' });
    const joinSql = joins.length ? ` ${joins.join(' ')}` : '';
    const whereSql = sql?.trim() ? ` WHERE ${sql}` : '';
    const cols = label
      ? `${q('t0')}.${q(field)}, ${q('t0')}.${q(label)}`
      : `${q('t0')}.${q(field)}`;
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
 * its own client) to materialize each field's option set.
 */
export const sourceQueries = (lensOrNarrowing: Lens | LensNarrowing): SourceQuery[] => {
  const { lens } = resolvePolicy(lensOrNarrowing);
  const projection = projectByPath(lensOrNarrowing);
  const out: SourceQuery[] = [];
  for (const [path, visit] of projection) {
    for (const [field, sourceClauses] of Object.entries(visit.sources)) {
      const composedWhere = compose(visit.whereClauses, sourceClauses);
      const label = visit.sourceLabels[field];
      const { prisma, sql } = compileOne(
        lens,
        visit.mapName,
        visit.modelName,
        field,
        label,
        composedWhere,
      );
      out.push({
        path,
        mapName: visit.mapName,
        model: visit.modelName,
        field,
        ...(label !== undefined ? { label } : {}),
        composedWhere,
        prisma,
        sql,
      });
    }
  }
  return out;
};
