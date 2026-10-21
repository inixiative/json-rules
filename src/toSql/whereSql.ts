import { compileFieldLiteral } from '../compileLiteral';
import { DEFAULT_ZONE } from '../dateExpr';
import { resolveCaseInsensitive } from '../engineGlobals';
import { pastScalarError, relationNotValue, toManyHopError, UsageError } from '../errors';
import { hasNoOperand, isExistenceTest } from '../field';
import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import { fieldShape } from '../fieldMap/shape';
import type { FieldMap, FieldMapSet } from '../fieldMap/types';
import { type MapWalkResult, walkFieldPath } from '../fieldMap/walk';
import { splitNull } from '../number';
import { Operator } from '../operator';
import { NEGATED_OPERATORS, WHERE_SQL_OPERATORS } from '../operatorCatalog';
import { parseScopeRef } from '../scope';
import { relationKeys } from '../toPrisma/relationUtils';
import { conditionShape } from '../traverse';
import type { Condition, Rule } from '../types';
import { noOperandSql, orNull } from './compare';

/** The SQL a `toWhereSql` predicate is written in. MySQL only, for now. */
export type WhereSqlDialect = 'mysql';

export type WhereSqlOptions = {
  /** Field path → the caller's SQL for that column, used as written. A to-one relation's
   *  existence reads `'<relation>.<key>'`. */
  columns: Record<string, string>;
  dialect: WhereSqlDialect;
  /** The schema the condition reads, to refuse what has no form here (dates, Json, lists,
   *  bridges) and to find a relation's key. Without it, every path is a column. */
  map?: FieldMap | FieldMapSet;
  mapName?: string;
  model?: string;
};

type Context = {
  dialect: WhereSqlDialect;
  column: (path: string) => string;
  map?: FieldMap;
  model?: string;
};

const refuse = (what: string): Error =>
  new Error(
    `toWhereSql: ${what} has no SQL form here — it writes ${WHERE_SQL_OPERATORS.join(', ')}, all and any.`,
  );

/**
 * A condition as a SQL predicate in `dialect`, with every value written inline and every field
 * read from `columns` — no parameters to fill, no joins. Negations keep NULL rows, as on every
 * rail. Throws for any operator but equals / notEquals / in / notIn / exists / notExists inside
 * all / any, and for binds, bridges, column-to-column `path`s, dates and Json.
 */
export const toWhereSql = (condition: Condition, options: WhereSqlOptions): string =>
  whereSql(condition, options, '');

/** toWhereSql reading `columns` under `prefix`: a relation path's visit, from the lens model. */
export const whereSql = (
  condition: Condition,
  options: WhereSqlOptions,
  prefix: string,
): string => {
  const { columns, dialect } = options ?? ({} as WhereSqlOptions);
  if (dialect !== 'mysql')
    throw new UsageError(`toWhereSql: dialect '${String(dialect)}' is not supported — 'mysql' is`);
  if (typeof columns !== 'object' || columns === null)
    throw new UsageError('toWhereSql: `columns` maps each field path to its SQL');
  const map = resolveFieldMap(options.map, options.mapName, 'toSql');
  return buildWhere(condition, {
    dialect,
    map,
    model: options.model,
    column: (field) => {
      const path = `${prefix}${field}`;
      const sql = Object.hasOwn(columns, path) ? columns[path] : undefined;
      if (typeof sql !== 'string' || sql === '')
        throw new UsageError(`toWhereSql: no column for '${path}' in \`columns\``);
      return sql;
    },
  });
};

const buildWhere = (condition: Condition, ctx: Context): string => {
  if (typeof condition === 'boolean') return condition ? 'TRUE' : 'FALSE';
  const node = condition as Record<string, unknown>;
  switch (conditionShape(node)) {
    case 'all': {
      const all = node.all as Condition[];
      return all.length ? `(${all.map((c) => buildWhere(c, ctx)).join(' AND ')})` : 'TRUE';
    }
    case 'any': {
      const any = node.any as Condition[];
      return any.length ? `(${any.map((c) => buildWhere(c, ctx)).join(' OR ')})` : 'FALSE';
    }
    case 'field':
      return buildField(condition as Rule, ctx);
    case 'if':
      throw refuse('if / then / else');
    case 'array':
      throw refuse(`arrayOperator '${String(node.arrayOperator)}'`);
    case 'aggregate':
      throw refuse('aggregate');
    case 'date':
      throw refuse(`dateOperator '${String(node.dateOperator)}'`);
    default:
      throw refuse('a condition that is not exactly one node kind');
  }
};

const buildField = (rule: Rule, ctx: Context): string => {
  if (!WHERE_SQL_OPERATORS.includes(rule.operator)) throw refuse(`operator '${rule.operator}'`);
  if (rule.bind !== undefined) throw refuse(`bind '${rule.bind}' on '${rule.field}'`);
  if (rule.path !== undefined)
    throw refuse(`comparing '${rule.field}' with the column '${rule.path}'`);
  if (rule.offset !== undefined) throw refuse(`an offset on '${rule.field}'`);
  if (rule.coerceType !== undefined) throw refuse(`coerceType on '${rule.field}'`);
  if (resolveCaseInsensitive(rule.caseInsensitive))
    throw refuse(`a case-insensitive comparison on '${rule.field}'`);
  if (parseScopeRef(rule.field)) throw refuse(`the scoped field '${rule.field}'`);

  const walk = ctx.map && ctx.model ? walkFieldPath(rule.field, ctx.map, ctx.model) : undefined;
  const field = columnOf(rule, walk, ctx);
  if (rule.operator === Operator.exists) return `${field} IS NOT NULL`;
  if (rule.operator === Operator.notExists) return `${field} IS NULL`;
  // A missing value reads as null, as check() reads it.
  const value = compileFieldLiteral(rule, rule.value ?? null, walk, 'toSql', () => DEFAULT_ZONE);
  if (hasNoOperand(rule, value))
    return noOperandSql(field, NEGATED_OPERATORS.includes(rule.operator));
  const lit = (v: unknown): string => literal(v, rule.field);

  switch (rule.operator) {
    case Operator.equals:
      return value === null ? `${field} IS NULL` : `${field} = ${lit(value)}`;
    case Operator.notEquals:
      return value === null ? `${field} IS NOT NULL` : orNull(field, `${field} <> ${lit(value)}`);
    case Operator.in: {
      const { values, hasNull } = splitNull(listOperand(rule, value));
      if (!values.length) return hasNull ? `${field} IS NULL` : 'FALSE';
      const anyOf = `${field} IN (${values.map(lit).join(', ')})`;
      return hasNull ? orNull(field, anyOf) : anyOf;
    }
    default: {
      // notIn
      const { values, hasNull } = splitNull(listOperand(rule, value));
      if (!values.length) return hasNull ? `${field} IS NOT NULL` : 'TRUE';
      const noneOf = `${field} NOT IN (${values.map(lit).join(', ')})`;
      return hasNull ? `(${noneOf} AND ${field} IS NOT NULL)` : orNull(field, noneOf);
    }
  }
};

/** The caller's SQL for a rule's field: its column, or for a to-one relation, the related row's
 *  key — NULL when there is no row. */
const columnOf = (rule: Rule, walk: MapWalkResult | undefined, ctx: Context): string => {
  if (!walk || walk.kind === 'fallback') return ctx.column(rule.field);
  if (walk.kind === 'past-scalar') throw pastScalarError(rule.field, walk.column);
  if (walk.kind === 'bridge') throw refuse(`'${rule.field}', which crosses a bridge`);
  const toMany = walk.hops.find((hop) => hop.entry.isList);
  if (toMany) throw toManyHopError(rule.field, toMany);
  const shape = fieldShape(walk);
  if (shape === 'json' || shape === 'json-path') throw refuse(`the Json value '${rule.field}'`);
  if (shape === 'instant') throw refuse(`the date '${rule.field}'`);
  if (shape === 'list' || shape === 'relations') throw refuse(`the list '${rule.field}'`);
  if (shape !== 'relation' || walk.kind !== 'direct') return ctx.column(rule.field);
  if (!isExistenceTest(rule)) throw relationNotValue(rule.field);
  const keys = relationKeys(ctx.map as FieldMap, walk.model, walk.entry);
  if (!keys) throw refuse(`'${rule.field}', whose relation keys the map does not declare`);
  return ctx.column(`${rule.field}.${keys[0].there}`);
};

const listOperand = (rule: Rule, value: unknown): unknown[] => {
  if (!Array.isArray(value))
    throw new Error(`toWhereSql: '${rule.operator}' on '${rule.field}' takes a list of values`);
  return value;
};

/** A value as a MySQL literal. A string escapes `\` and `'`: MySQL's default mode reads a
 *  backslash in a string as an escape. */
const literal = (value: unknown, field: string): string => {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  throw refuse(
    `the value ${value instanceof Date ? 'a Date' : JSON.stringify(value)} for '${field}'`,
  );
};
