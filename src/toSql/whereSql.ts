import { compileFieldLiteral } from '../compileLiteral';
import { DEFAULT_ZONE } from '../dateExpr';
import { engineGlobals, isSqlDialect, resolveCaseInsensitive, SqlDialect } from '../engineGlobals';
import { pastScalarError, relationNotValue, toManyHopError, UsageError } from '../errors';
import { hasNoOperand, isExistenceTest } from '../field';
import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import { entryKind, fieldShape } from '../fieldMap/shape';
import type { FieldMap, FieldMapSet } from '../fieldMap/types';
import { type MapWalkResult, walkFieldPath } from '../fieldMap/walk';
import { leafFitViolations } from '../lens/fieldFit';
import { splitNull } from '../number';
import { Operator } from '../operator';
import { NEGATED_OPERATORS, WHERE_SQL_OPERATORS } from '../operatorCatalog';
import { modelOf } from '../own';
import { parseScopeRef } from '../scope';
import { relationKeys } from '../toPrisma/relationUtils';
import { conditionShape } from '../traverse';
import type { Condition, Rule } from '../types';
import { noOperandSql, orNull } from './compare';

export type WhereSqlOptions = {
  /** Field path → the caller's SQL for that column, used as written. A to-one relation's
   *  existence reads `'<relation>.<key>'`. */
  columns: Record<string, string>;
  /** The schema the condition reads: it types each literal by its column, finds a relation's key,
   *  and refuses what has no form here (a date, Json or list value, a bridge, a to-many hop). */
  map: FieldMap | FieldMapSet;
  mapName?: string;
  model: string;
};

type Context = {
  dialect: SqlDialect;
  column: (path: string) => string;
  map: FieldMap;
  model: string;
};

const refuse = (what: string): Error =>
  new Error(
    `toWhereSql: ${what} has no SQL form here — it writes ${WHERE_SQL_OPERATORS.join(', ')}, all and any.`,
  );

/**
 * A condition as a SQL predicate in the engine's `sql.dialect`, with every value written inline
 * and every field read from `columns` — no parameters to fill, no joins. Negations keep NULL rows,
 * as on every rail. Throws for any operator but equals / notEquals / in / notIn / exists /
 * notExists inside all / any, and for binds, bridges, column-to-column `path`s, a Json value or
 * existence, and a date or list value (their existence is fine: `IS NULL` compares no value).
 */
export const toWhereSql = (condition: Condition, options: WhereSqlOptions): string =>
  whereSql(condition, options, '');

/** toWhereSql reading `columns` under `prefix`: a relation path's visit, from the lens model. */
export const whereSql = (
  condition: Condition,
  options: WhereSqlOptions,
  prefix: string,
): string => {
  const dialect = engineGlobals.get('sql.dialect');
  if (!isSqlDialect(dialect))
    throw new UsageError(
      `toWhereSql: sql.dialect '${String(dialect)}' is not a SQL dialect — ${Object.values(SqlDialect).join(', ')} are`,
    );
  const { columns, map: given, mapName, model } = options ?? ({} as WhereSqlOptions);
  if (typeof columns !== 'object' || columns === null)
    throw new UsageError('toWhereSql: `columns` maps each field path to its SQL');
  if (!given || !model)
    throw new UsageError(
      'toWhereSql: `map` and `model` are required — a literal is typed by its column, and a date, Json or list value is refused by it',
    );
  const map = resolveFieldMap(given, mapName, 'toWhereSql') as FieldMap;
  if (!modelOf(map, model)) throw new UsageError(`toWhereSql: the map has no model '${model}'`);
  return buildWhere(condition, {
    dialect,
    map,
    model,
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

  const walk = walkFieldPath(rule.field, ctx.map, ctx.model);
  const field = columnOf(rule, walk, ctx);
  // MySQL casts a value of another type (`score = TRUE`, `enum = 1`), matching rows check() doesn't.
  const [misfit] = walk.kind === 'direct' ? leafFitViolations(rule, entryKind(walk.entry)) : [];
  if (misfit) throw new Error(`toWhereSql: ${misfit.message}`);
  if (rule.operator === Operator.exists) return `${field} IS NOT NULL`;
  if (rule.operator === Operator.notExists) return `${field} IS NULL`;
  // No operand at all is an authoring error on every rail, never a NULL test.
  if (rule.value === undefined) throw new Error('No value, path or bind specified');
  const value = compileFieldLiteral(rule, rule.value, walk, 'toWhereSql', () => DEFAULT_ZONE);
  if (hasNoOperand(rule, value))
    return noOperandSql(field, NEGATED_OPERATORS.includes(rule.operator));
  const lit = (v: unknown): string => literal(v, rule.field, ctx.dialect);

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
 *  key — NULL when there is no row. A date's or list's existence compiles (`IS NULL` compares no
 *  value); their VALUE, and anything Json, has no form here. */
const columnOf = (rule: Rule, walk: MapWalkResult, ctx: Context): string => {
  // An undeclared path has no type to check a value against.
  if (walk.kind === 'fallback')
    throw new Error(`toWhereSql: '${rule.field}' is not a field the map declares on ${ctx.model}`);
  if (walk.kind === 'past-scalar') throw pastScalarError(rule.field, walk.column);
  if (walk.kind === 'bridge') throw refuse(`'${rule.field}', which crosses a bridge`);
  const toMany = walk.hops.find((hop) => hop.entry.isList);
  if (toMany) throw toManyHopError(rule.field, toMany);
  const shape = fieldShape(walk);
  const existence = isExistenceTest(rule);
  if (shape === 'relation' && walk.kind === 'direct') {
    if (!existence) throw relationNotValue(rule.field);
    const keys = relationKeys(ctx.map, walk.model, walk.entry);
    if (!keys) throw refuse(`'${rule.field}', whose relation keys the map does not declare`);
    return ctx.column(`${rule.field}.${keys[0].there}`);
  }
  if (shape === 'relations') throw refuse(`the list '${rule.field}'`);
  // A Json column's existence is not `IS NULL` either: a stored JSON null is a value to SQL and
  // null to check() (toSql writes NULLIF(col, 'null'::jsonb); toPrisma, AnyNull).
  if (shape === 'json' || shape === 'json-path') throw refuse(`the Json value '${rule.field}'`);
  if (existence) return ctx.column(rule.field);
  if (shape === 'instant') throw refuse(`the date '${rule.field}'`);
  if (shape === 'list') throw refuse(`the list '${rule.field}'`);
  return ctx.column(rule.field);
};

const listOperand = (rule: Rule, value: unknown): unknown[] => {
  if (!Array.isArray(value))
    throw new Error(`toWhereSql: '${rule.operator}' on '${rule.field}' takes a list of values`);
  return value;
};

/** A value as a SQL literal in `dialect`. A string doubles `'` everywhere; MySQL's default mode
 *  also reads a backslash as an escape, so it is doubled there. */
const literal = (value: unknown, field: string, dialect: SqlDialect): string => {
  if (typeof value === 'string') {
    const quoted = value.replace(/'/g, "''");
    return `'${dialect === SqlDialect.mysql ? quoted.replace(/\\/g, '\\\\') : quoted}'`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  throw refuse(
    `the value ${value instanceof Date ? 'a Date' : JSON.stringify(value)} for '${field}'`,
  );
};
