import { resolveCaseInsensitive } from '../engineGlobals';
import { enumMatches } from '../enumMatch';
import { hasNoOperand } from '../field';
import { orderPair, splitNull } from '../number';
import { Operator } from '../operator';
import { NEGATED_OPERATORS, NO_VALUE_OPERATORS, RANGE_OPERATORS } from '../operatorCatalog';
import { readPattern } from '../pattern';
import {
  acceptsEmptyString,
  compileFieldLiteral,
  type FieldShape,
  fieldEntry,
  walkWith,
} from '../toPrisma/mapWalk';
import type { Rule } from '../types';
import { compareSql, noOperandSql, ORDERED_SQL, orNull as orNullSql, rangeSql } from './compare';
import { type FieldSql, resolveField, resolveFieldSql } from './join';
import { buildJsonComparison } from './json';
import { offsetNumber } from './offset';
import { nextParam } from './params';
import { escapeLikePattern } from './quoting';
import type { BuilderState } from './types';
import { dateConfigOf, type ResolvedRhs, resolveSource } from './valueSource';

/** A field rule as SQL; `lhs` compiles a computed left-hand side (an aggregate) in the column's place. */
export const buildFieldRule = (rule: Rule, state: BuilderState, lhs?: string): string => {
  if (rule.fuzzy)
    throw new Error('Fuzzy matching has no SQL equivalent — evaluate it in memory with check().');
  const resolved: FieldSql =
    lhs === undefined ? resolveField(rule.field, state) : { sql: lhs, shape: 'scalar' };
  // A to-one relation as a field exists or not: its key is not a value to compare.
  if (resolved.shape === 'relation' && !NO_VALUE_OPERATORS.includes(rule.operator)) {
    const rhs = resolveSource(rule, state);
    if (!(rhs.type === 'value' && rhs.value === null && EQUALITY.includes(rule.operator)))
      throw new Error(
        `'${rule.field}' is a relation: it exists or not; compare its fields with '${rule.field}.<field>'.`,
      );
  }
  // A computed left-hand side is never NULL (an aggregate coalesces): no NULL arms.
  const nullable = lhs === undefined;
  // An enum compares against its declared values (see enumMatches).
  if (resolved.shape === 'enum' && !NO_VALUE_OPERATORS.includes(rule.operator)) {
    const operand = knownOperand(rule, state);
    const entry = fieldEntry(rule.field, state.map, state.currentModel);
    const matched =
      operand !== NOT_KNOWN && entry && !hasNoOperand(rule, operand)
        ? enumMatches(rule, operand, entry, state.map)
        : null;
    if (matched) {
      const listed = `${resolved.sql}::text = ANY(${nextParam(state, matched.values)})`;
      return matched.matchesNull ? orNullSql(resolved.sql, listed) : listed;
    }
  }
  // An enum's exact comparisons read its value as text, which a string parameter matches.
  const compared: FieldSql =
    resolved.shape === 'enum' && !NO_VALUE_OPERATORS.includes(rule.operator)
      ? { ...resolved, sql: `${resolved.sql}::text` }
      : resolved;
  // A Json value against an operand known now compares as JSON.
  const isJson = resolved.shape === 'json' || resolved.shape === 'json-path';
  if (isJson && !NO_VALUE_OPERATORS.includes(rule.operator)) {
    const operand = knownOperand(rule, state);
    if (operand !== NOT_KNOWN)
      return buildJsonComparison(
        rule,
        resolveFieldSql(rule.field, state, { jsonb: true }),
        operand,
        state,
      );
  }
  if (RANGE_OPERATORS.includes(rule.operator)) {
    const ends = resolveRange(rule, state);
    return rangeSql(compared.sql, ends, rule.operator === Operator.notBetween, state, nullable);
  }
  const rhs = resolveComparison(rule, state);
  const field = compared.sql;
  const ordered = ORDERED_SQL[rule.operator];
  if (ordered) return compareSql(field, ordered.symbol, rhs, false, state);
  // Nothing to compare against (see hasNoOperand): no row, or the NULL fields for a negation.
  if (rhs.type === 'value' && hasNoOperand(rule, rhs.value))
    return noOperandSql(field, NEGATED_OPERATORS.includes(rule.operator), nullable);
  const arithmetic = rhs.type === 'column' && rhs.computed === true;
  // Case-insensitive compares text, as check() lowercases only strings.
  const text = (shape: FieldShape | undefined) =>
    shape !== 'scalar' && shape !== 'list' && shape !== 'enum';
  const lower =
    resolveCaseInsensitive(rule.caseInsensitive) &&
    text(resolved.shape) &&
    (rhs.type === 'column' ? !arithmetic && text(rhs.shape) : hasString(rhs.value));
  const lc = (expr: string): string => (lower ? `LOWER(${expr})` : expr);
  const lowered = (values: unknown[]): unknown[] =>
    lower ? values.map((v) => (typeof v === 'string' ? v.toLowerCase() : v)) : values;

  // A scalar list contains a member, as check() reads a list; NULL elements and a NULL list
  // contain nothing.
  if (resolved.shape === 'list' && rule.operator === Operator.contains)
    return `array_position(${field}, ${nextParam(state, rhs.type === 'value' ? rhs.value : null)}) IS NOT NULL`;
  if (resolved.shape === 'list' && rule.operator === Operator.notContains)
    return `array_position(${field}, ${nextParam(state, rhs.type === 'value' ? rhs.value : null)}) IS NULL`;

  // Extract both variants up front so TypeScript doesn't need to narrow inside each case
  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  // Every negation carries the NULL rows explicitly (see ./compare).
  const orNull = (expr: string): string => (nullable ? orNullSql(field, expr) : expr);

  switch (rule.operator) {
    case Operator.equals:
      if (arithmetic) return `${field} = ${rhsCol}`;
      if (rhsCol !== undefined) return `${lc(field)} IS NOT DISTINCT FROM ${lc(rhsCol)}`;
      if (rhsVal === null) return `${field} IS NULL`;
      return `${lc(field)} = ${lc(nextParam(state, rhsVal))}`;

    case Operator.notEquals:
      if (arithmetic) return orNull(`${field} <> ${rhsCol}`);
      if (rhsCol !== undefined) return `${lc(field)} IS DISTINCT FROM ${lc(rhsCol)}`;
      if (rhsVal === null) return `${field} IS NOT NULL`;
      return orNull(`${lc(field)} <> ${lc(nextParam(state, rhsVal))}`);

    case Operator.in: {
      const { values, hasNull } = splitNull(rhsVal);
      if (!values.length) return hasNull ? `${field} IS NULL` : 'FALSE';
      const anyOf = `${lc(field)} = ANY(${nextParam(state, lowered(values))})`;
      return hasNull ? orNull(anyOf) : anyOf;
    }

    case Operator.notIn: {
      const { values, hasNull } = splitNull(rhsVal);
      if (!values.length) return hasNull ? `${field} IS NOT NULL` : 'TRUE';
      const noneOf = `${lc(field)} <> ALL(${nextParam(state, lowered(values))})`;
      return hasNull ? `(${noneOf} AND ${field} IS NOT NULL)` : orNull(noneOf);
    }

    case Operator.contains:
      return `${lc(field)} LIKE ${lc(nextParam(state, `%${escapeLikePattern(String(rhsVal))}%`))}`;

    case Operator.notContains:
      return orNull(
        `${lc(field)} NOT LIKE ${lc(nextParam(state, `%${escapeLikePattern(String(rhsVal))}%`))}`,
      );

    case Operator.startsWith:
      return `${lc(field)} LIKE ${lc(nextParam(state, `${escapeLikePattern(String(rhsVal))}%`))}`;

    case Operator.endsWith:
      return `${lc(field)} LIKE ${lc(nextParam(state, `%${escapeLikePattern(String(rhsVal))}`))}`;

    case Operator.matches:
      return `${field} ~ ${nextParam(state, sqlPattern(rhsVal))}`;

    case Operator.notMatches:
      return orNull(`${field} !~ ${nextParam(state, sqlPattern(rhsVal))}`);

    case Operator.isEmpty:
    case Operator.notEmpty:
      return emptinessSql(
        rule.field,
        resolved,
        rule.operator === Operator.isEmpty,
        state,
        acceptsEmptyString(rule, state.map, state.currentModel),
      );

    case Operator.exists:
      return `${field} IS NOT NULL`;

    case Operator.notExists:
      return `${field} IS NULL`;

    default:
      throw new Error(`Unknown operator: ${(rule as Rule).operator}`);
  }
};

/** The comparison operand: the rule's value source, coerced to the field, moved by its offset. */
const resolveComparison = (rule: Rule, state: BuilderState): ResolvedRhs => {
  if (NO_VALUE_OPERATORS.includes(rule.operator)) return { type: 'value', value: undefined };
  const rhs = coerce(rule, resolveSource(rule, state), state);
  return rule.offset === undefined ? rhs : offsetNumber(rhs, rule.offset, state);
};

const coerce = (rule: Rule, rhs: ResolvedRhs, state: BuilderState): ResolvedRhs =>
  rhs.type === 'column'
    ? rhs
    : {
        type: 'value',
        value: compileFieldLiteral(
          rule,
          rhs.value,
          walkWith(rule.field, state.map, state.currentModel),
          'toSql',
          () => dateConfigOf(state).timeZone,
        ),
      };

/** A range's two ends, sorted, each moved by the offset; null when the range reads nothing. */
const resolveRange = (rule: Rule, state: BuilderState): [ResolvedRhs, ResolvedRhs] | null => {
  const rhs = coerce(rule, resolveSource(rule, state), state);
  const range = rhs.type === 'value' ? rhs.value : undefined;
  if (range === null || range === undefined) return null;
  if (!Array.isArray(range) || range.length !== 2)
    throw new Error(`${rule.operator} operator requires an array of two values`);
  return orderPair(range).map((value) => {
    const end: ResolvedRhs = { type: 'value', value };
    return rule.offset === undefined ? end : offsetNumber(end, rule.offset, state);
  }) as [ResolvedRhs, ResolvedRhs];
};

const EQUALITY: readonly string[] = [Operator.equals, Operator.notEquals];

const hasString = (operand: unknown): boolean =>
  Array.isArray(operand)
    ? operand.some((item) => typeof item === 'string')
    : typeof operand === 'string';

/** A pattern's source for Postgres `~`, refused when it can backtrack exponentially. */
const sqlPattern = (value: unknown): string => {
  if (typeof value !== 'string' && !(value instanceof RegExp))
    throw new Error('matches requires a string or RegExp pattern');
  return readPattern(value).source;
};

const NOT_KNOWN = Symbol('not known');

/** A comparison's operand when it is known now — a value, or a range of two values — or
 *  NOT_KNOWN when it is read per row (a column, an offset). */
const knownOperand = (rule: Rule, state: BuilderState): unknown => {
  if (rule.offset !== undefined) return NOT_KNOWN;
  if (RANGE_OPERATORS.includes(rule.operator)) {
    const ends = resolveRange(rule, state);
    if (!ends) return null;
    return ends.every((end) => end.type === 'value')
      ? ends.map((end) => (end as { value: unknown }).value)
      : NOT_KNOWN;
  }
  const rhs = resolveComparison(rule, state);
  return rhs.type === 'value' ? rhs.value : NOT_KNOWN;
};

/**
 * Whether a field is empty — NULL, '', or an empty list or Json array, as check() reads it — or,
 * with `empty` false, not. One form for the emptiness operators and the array ones.
 */
export const emptinessSql = (
  path: string,
  field: FieldSql,
  empty: boolean,
  state: BuilderState,
  emptyString: boolean,
): string => {
  const { sql, shape } = field;
  if (shape === 'list')
    return empty ? `(${sql} IS NULL OR cardinality(${sql}) = 0)` : `cardinality(${sql}) > 0`;
  if (shape === 'json' || shape === 'json-path') {
    const j = resolveFieldSql(path, state, { jsonb: true });
    const values = [`'null'::jsonb`, ...(emptyString ? [`'""'::jsonb`] : []), `'[]'::jsonb`].join(
      ', ',
    );
    return empty ? `(${j} IS NULL OR ${j} IN (${values}))` : `${j} NOT IN (${values})`;
  }
  if (!emptyString) return empty ? `${sql} IS NULL` : `${sql} IS NOT NULL`;
  return empty ? `(${sql} IS NULL OR ${sql} = '')` : `(${sql} IS NOT NULL AND ${sql} <> '')`;
};
