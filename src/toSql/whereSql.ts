import { compileFieldLiteral } from '../compileLiteral';
import { DEFAULT_ZONE } from '../dateExpr';
import { engineGlobals, isSqlDialect, resolveCaseInsensitive, SqlDialect } from '../engineGlobals';
import {
  conditionRequired,
  pastScalarError,
  relationNotValue,
  toManyHopError,
  UsageError,
} from '../errors';
import { hasNoOperand, isExistenceTest } from '../field';
import { resolveFieldMap } from '../fieldMap/resolveFieldMap';
import { entryKind, fieldShape } from '../fieldMap/shape';
import type { FieldMap, FieldMapSet } from '../fieldMap/types';
import { type MapWalkResult, walkFieldPath } from '../fieldMap/walk';
import { leafFitViolations } from '../lens/fieldFit';
import { splitNull } from '../number';
import { ArrayOperator, Operator } from '../operator';
import {
  ARRAY_CONDITION_OPERATORS,
  HOLDS_ON_NO_ROWS_OPERATORS,
  NEGATED_OPERATORS,
  WHERE_SQL_ARRAY_OPERATORS,
  WHERE_SQL_OPERATORS,
} from '../operatorCatalog';
import { modelOf } from '../own';
import { parseScopeRef } from '../scope';
import { relationKeys } from '../toPrisma/relationUtils';
import { conditionShape } from '../traverse';
import type { ArrayRule, Condition, Rule } from '../types';
import { hasWindow } from '../window';
import { noOperandSql, orNull } from './compare';

export type WhereSqlOptions = {
  /** Field path → the caller's SQL for that column, used as written. A to-one relation's
   *  existence reads `'<relation>.<key>'`; a to-many relation's rows read
   *  `'<relation>.<field>'`. */
  columns: Record<string, string>;
  /** To-many relation path → the caller's SQL for its table, written after `FROM` as given, with
   *  the alias its `columns` read (`{ affiliations: 'FanUserAffiliation AS a' }`). An array rule
   *  on that relation reads it. */
  tables?: Record<string, string>;
  /** The schema the condition reads: it types each literal by its column, finds a relation's key,
   *  and refuses what has no form here (a date, Json or list value, a bridge, a to-many hop). */
  map: FieldMap | FieldMapSet;
  mapName?: string;
  model: string;
};

/** The clamps a to-many relation's rows carry, by the relation's path from where the compile
 *  started: what `check()` reads through that hop under a lens. A bare condition has none. */
export type RelationClamps = (relationPath: string) => RelationClamp[];

/** One clamp on a relation's rows, and the clamps it reads its own to-many relations through —
 *  from the relation's model. */
export type RelationClamp = { where: Condition; clamps: RelationClamps };

/** Vets a read of a to-many relation on the caller's join, by the relation's path from where the
 *  compile started, before it compiles: throws when the join can't give the rows check() reads. */
export type JoinedRelation = (relationPath: string, operator: ArrayOperator) => void;

/** How a compile reads a to-many relation's rows: in a subquery that carries their clamps, or on
 *  the row the caller's LEFT JOIN brings, whose ON carries them (`toLensWhereSql`'s
 *  `toMany: 'join'`). */
export type ToManyRows = { clamps: RelationClamps } | { joined: JoinedRelation };

type Context = {
  column: (path: string) => string;
  table: (path: string) => string;
  clamps: RelationClamps;
  /** Join mode: vets each to-many relation read on the caller's join. Null: a subquery. */
  joined: JoinedRelation | null;
  /** Inside a joined `any`: the relation whose joined row this reads. */
  joinedRow: string | null;
  map: FieldMap;
  model: string;
};

/** The engine's `sql.dialect`, refused when it names none. */
const sqlDialect = (): SqlDialect => {
  const dialect = engineGlobals.get('sql.dialect');
  if (!isSqlDialect(dialect))
    throw new UsageError(
      `toWhereSql: sql.dialect '${String(dialect)}' is not a SQL dialect — ${Object.values(SqlDialect).join(', ')} are`,
    );
  return dialect;
};

const refuse = (what: string): Error =>
  new Error(
    `toWhereSql: ${what} has no SQL form here — it writes ${WHERE_SQL_OPERATORS.join(', ')}, all and any, and ${WHERE_SQL_ARRAY_OPERATORS.join(', ')} over a to-many relation.`,
  );

/**
 * A condition as a SQL predicate in the engine's `sql.dialect`, with every value written inline
 * and every field read from `columns` — no parameters to fill, no joins. Negations keep NULL rows,
 * as on every rail. An array rule (any / all / none / empty / notEmpty) on a to-many relation of
 * the model is an `EXISTS` subquery on its table from `tables`. Throws for any other operator or
 * node, for binds, bridges, column-to-column `path`s, a Json value or existence, and a date or
 * list value (their existence is fine: `IS NULL` compares no value).
 */
export const toWhereSql = (condition: Condition, options: WhereSqlOptions): string =>
  whereSql(condition, options, '');

/** The caller's SQL for `path` in one of its maps, refused when it gives none. */
const given = (source: Record<string, string>, name: string, what: string, path: string) => {
  const sql = Object.hasOwn(source, path) ? source[path] : undefined;
  if (typeof sql !== 'string' || sql === '')
    throw new UsageError(`toWhereSql: no ${what} for '${path}' in \`${name}\``);
  return sql;
};

/** toWhereSql reading `columns` and `tables` under `prefix` (a relation path's visit, from the lens
 *  model), each to-many relation's rows as `toMany` says. */
export const whereSql = (
  condition: Condition,
  options: WhereSqlOptions,
  prefix: string,
  toMany: ToManyRows = { clamps: () => [] },
): string => {
  sqlDialect();
  const { columns, tables = {}, map: schema, mapName, model } = options ?? ({} as WhereSqlOptions);
  if (typeof columns !== 'object' || columns === null)
    throw new UsageError('toWhereSql: `columns` maps each field path to its SQL');
  if (typeof tables !== 'object' || tables === null)
    throw new UsageError('toWhereSql: `tables` maps each to-many relation path to its table');
  if (!schema || !model)
    throw new UsageError(
      'toWhereSql: `map` and `model` are required — a literal is typed by its column, and a date, Json or list value is refused by it',
    );
  const map = resolveFieldMap(schema, mapName, 'toWhereSql') as FieldMap;
  if (!modelOf(map, model)) throw new UsageError(`toWhereSql: the map has no model '${model}'`);
  return buildWhere(condition, {
    map,
    model,
    column: (field) => given(columns, 'columns', 'column', `${prefix}${field}`),
    table: (field) => given(tables, 'tables', 'table', `${prefix}${field}`),
    clamps: 'clamps' in toMany ? toMany.clamps : () => [],
    joined: 'joined' in toMany ? toMany.joined : null,
    joinedRow: null,
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
      return buildArray(condition as ArrayRule, ctx);
    case 'aggregate':
      throw refuse('aggregate');
    case 'date':
      throw refuse(`dateOperator '${String(node.dateOperator)}'`);
    default:
      throw refuse('a condition that is not exactly one node kind');
  }
};

/**
 * An array rule on a to-many relation of the model as one subquery on the relation's table: its
 * rows keyed to this row and kept by the relation's clamps, as `check()` reads them under a lens.
 * `any` / `notEmpty`: such a row exists; `none` / `empty`: none does; `all`: none fails the
 * condition — `IS NOT TRUE`, so a NULL result fails, as in `check()`. A clamp stays outside it: a
 * row the clamp hides is not there to fail.
 *
 * In join mode it reads the row the caller's LEFT JOIN brings, its clamps in the ON: `notEmpty` is
 * the key `IS NOT NULL`, `any` that and its condition on the joined columns. A matched row's key
 * equals the parent's, never NULL, and an unmatched one is all NULL, so the first key column
 * decides, as a to-one relation's existence reads it. What can hold with no rows takes an
 * anti-join, and is refused.
 */
const buildArray = (rule: ArrayRule, ctx: Context): string => {
  const { arrayOperator: operator, field } = rule;
  if (!WHERE_SQL_ARRAY_OPERATORS.includes(operator)) throw refuse(`arrayOperator '${operator}'`);
  if (hasWindow(rule)) throw refuse(`a window (filter / orderBy / take / skip) on '${field}'`);
  if (!field) throw refuse(`the fieldless arrayOperator '${operator}'`);
  const walk = walkFieldPath(field, ctx.map, ctx.model);
  if (walk.kind === 'fallback')
    throw new Error(`toWhereSql: '${field}' is not a field the map declares on ${ctx.model}`);
  if (walk.kind === 'bridge') throw refuse(`'${field}', which crosses a bridge`);
  if (walk.hops.length)
    throw refuse(
      `arrayOperator '${operator}' on '${field}', behind the relation '${walk.hops[0].prefix}'`,
    );
  if (walk.kind !== 'direct' || fieldShape(walk) !== 'relations')
    throw refuse(`arrayOperator '${operator}' on '${field}', which is not a to-many relation`);
  const keys = relationKeys(ctx.map, walk.model, walk.entry);
  if (!keys) throw refuse(`'${field}', whose relation keys the map does not declare`);
  if (ARRAY_CONDITION_OPERATORS.includes(operator) && rule.condition === undefined)
    throw conditionRequired(operator);
  if (ctx.joinedRow !== null)
    throw new Error(
      `toWhereSql: arrayOperator '${operator}' on '${field}' inside an any over the joined '${ctx.joinedRow}' — a joined row's own to-many relations have no join here; compile with toMany: 'subquery'`,
    );

  const rows: Context = {
    map: ctx.map,
    model: walk.entry.type,
    column: (path) => ctx.column(`${field}.${path}`),
    table: (path) => ctx.table(`${field}.${path}`),
    clamps: (path) => ctx.clamps(`${field}.${path}`),
    joined: ctx.joined,
    joinedRow: null,
  };
  if (ctx.joined) {
    if (HOLDS_ON_NO_ROWS_OPERATORS.includes(operator))
      throw new Error(
        `toWhereSql: arrayOperator '${operator}' on '${field}', a relation the caller joins, holds when it has no rows — that takes an anti-join, not the topic's join. Only notEmpty and any(condition) read a joined relation; compile with toMany: 'subquery' for the rest`,
      );
    ctx.joined(field, operator);
    const present = `${rows.column(keys[0].there)} IS NOT NULL`;
    if (operator !== ArrayOperator.any) return present;
    return `(${present} AND ${buildWhere(rule.condition as Condition, { ...rows, joinedRow: field })})`;
  }
  const scope = [
    ...keys.map(({ here, there }) => `${rows.column(there)} = ${ctx.column(here)}`),
    ...ctx.clamps(field).map(({ where, clamps }) => `(${buildWhere(where, { ...rows, clamps })})`),
  ];
  const subquery = (test?: string): string =>
    `(SELECT 1 FROM ${ctx.table(field)} WHERE ${[...scope, ...(test ? [test] : [])].join(' AND ')})`;
  const each = (): string => `(${buildWhere(rule.condition as Condition, rows)})`;
  switch (operator) {
    case ArrayOperator.any:
      return `EXISTS ${subquery(each())}`;
    case ArrayOperator.none:
      return `NOT EXISTS ${subquery(each())}`;
    case ArrayOperator.all:
      return `NOT EXISTS ${subquery(`${each()} IS NOT TRUE`)}`;
    case ArrayOperator.empty:
      return `NOT EXISTS ${subquery()}`;
    default:
      return `EXISTS ${subquery()}`;
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
  // A relation of a joined row needs a join of its own, with clamps nothing here has vetted.
  if (ctx.joinedRow !== null && (walk.hops.length || shape === 'relation'))
    throw new Error(
      `toWhereSql: '${rule.field}' inside an any over the joined '${ctx.joinedRow}' reads the relation '${walk.hops[0]?.prefix ?? rule.field}' — a joined row's own relations have no join here; compile with toMany: 'subquery'`,
    );
  if (shape === 'relation' && walk.kind === 'direct') {
    if (!existence) throw relationNotValue(rule.field);
    const keys = relationKeys(ctx.map, walk.model, walk.entry);
    if (!keys) throw refuse(`'${rule.field}', whose relation keys the map does not declare`);
    return ctx.column(`${rule.field}.${keys[0].there}`);
  }
  if (shape === 'relations')
    throw new Error(
      `toWhereSql: '${rule.field}' is a to-many relation — its rows take an arrayOperator rule: { field: '${rule.field}', arrayOperator: 'notEmpty' } for a row, 'empty' for none`,
    );
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

/** A value as a SQL literal in the engine's `sql.dialect`. A string doubles `'` everywhere;
 *  MySQL's default mode also reads a backslash as an escape, so it is doubled there. */
const literal = (value: unknown, field: string): string => {
  if (typeof value === 'string') {
    const quoted = value.replace(/'/g, "''");
    return `'${sqlDialect() === SqlDialect.mysql ? quoted.replace(/\\/g, '\\\\') : quoted}'`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  throw refuse(
    `the value ${value instanceof Date ? 'a Date' : JSON.stringify(value)} for '${field}'`,
  );
};
