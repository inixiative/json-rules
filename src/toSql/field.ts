import { compileFieldLiteral } from '../compileLiteral';
import { resolveCaseInsensitive } from '../engineGlobals';
import { enumMatches } from '../enumMatch';
import { fuzzyNotCompiled, relationNotValue } from '../errors';
import { hasNoOperand, isExistenceTest, listMembership, lowerStrings } from '../field';
import { acceptsEmptyString, comparesText, readsText } from '../fieldMap/shape';
import { fieldEntry, walkWith } from '../fieldMap/walk';
import { orderPair, readPair, splitNull } from '../number';
import { Operator } from '../operator';
import {
  CONTAINS_OPERATORS,
  EQUALITY_OPERATORS,
  getValueShape,
  NEGATED_OPERATORS,
  NO_VALUE_OPERATORS,
  RANGE_OPERATORS,
  SET_OPERATORS,
} from '../operatorCatalog';
import { postgresSource, readPattern } from '../pattern';
import type { Rule } from '../types';
import { compareSql, noOperandSql, orderedSql, orNull as orNullSql, rangeSql } from './compare';
import { type FieldSql, resolveField, resolveFieldSql } from './join';
import { buildJsonComparison } from './json';
import { offsetNumber } from './offset';
import { nextParam } from './params';
import { escapeLikePattern } from './quoting';
import { buildCondition } from './recurse';
import type { BuilderState } from './types';
import { dateConfigOf, type ResolvedRhs, resolveSource } from './valueSource';

/** A field rule as SQL; `lhs` compiles a computed left-hand side (an aggregate) in the column's place. */
export const buildFieldRule = (rule: Rule, state: BuilderState, lhs?: string): string => {
  const fuzzy = fuzzyNotCompiled(rule);
  if (fuzzy) throw fuzzy;
  const resolved: FieldSql =
    lhs === undefined ? resolveField(rule.field, state) : { sql: lhs, shape: 'scalar' };
  // A to-one relation as a field exists or not: its key is not a value to compare.
  if (resolved.shape === 'relation' && !isExistenceTest(rule)) throw relationNotValue(rule.field);
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
    // A Json value compares by its type, which a per-row operand doesn't fix at compile time.
    if (operand === NOT_KNOWN)
      throw new Error(
        `The Json value '${rule.field}' compares against an operand known when compiling, not one read per row.`,
      );
    return buildJsonComparison(
      rule,
      resolveFieldSql(rule.field, state, { jsonb: true }),
      operand,
      state,
    );
  }
  // check() compares a Json value as JSON, never across types; SQL would compare its text.
  const refuseJsonOperand = (operand: ResolvedRhs): void => {
    if (
      operand.type === 'column' &&
      !operand.computed &&
      (operand.shape === 'json' || operand.shape === 'json-path')
    )
      throw new Error(
        `'${rule.field}' compared with a Json value read per row has no SQL form; use check().`,
      );
  };
  if (RANGE_OPERATORS.includes(rule.operator)) {
    const ends = resolveRange(rule, state);
    ends?.forEach(refuseJsonOperand);
    return rangeSql(compared.sql, ends, NEGATED_OPERATORS.includes(rule.operator), state, nullable);
  }
  const rhs = resolveComparison(rule, state);
  refuseJsonOperand(rhs);
  const field = compared.sql;
  const ordered = orderedSql(rule.operator, 'field');
  if (ordered) return compareSql(field, ordered.symbol, rhs, false, state);
  // Nothing to compare against (see hasNoOperand): no row, or the NULL fields for a negation.
  if (rhs.type === 'value' && hasNoOperand(rule, rhs.value))
    return noOperandSql(field, NEGATED_OPERATORS.includes(rule.operator), nullable);
  const arithmetic = rhs.type === 'column' && rhs.computed === true;
  const lower =
    resolveCaseInsensitive(rule.caseInsensitive) &&
    (rhs.type === 'column'
      ? !arithmetic && readsText(resolved.shape) && readsText(rhs.shape)
      : comparesText(resolved.shape, rhs.value));
  const lc = (expr: string): string => (lower ? `LOWER(${expr})` : expr);
  const lowered = (values: unknown[]): unknown => (lower ? lowerStrings(values) : values);

  // A member read per row: a NULL one is nothing to look for, so only a NULL list is without it.
  if (
    resolved.shape === 'list' &&
    rhs.type === 'column' &&
    CONTAINS_OPERATORS.includes(rule.operator)
  ) {
    const has =
      resolveCaseInsensitive(rule.caseInsensitive) && readsText(rhs.shape)
        ? `EXISTS (SELECT 1 FROM unnest(${field}) AS e WHERE LOWER(e) = LOWER(${rhs.sql}))`
        : `array_position(${field}, ${rhs.sql}) IS NOT NULL`;
    return rule.operator === Operator.contains
      ? `(${rhs.sql} IS NOT NULL AND ${has})`
      : `(${field} IS NULL OR (${rhs.sql} IS NOT NULL AND NOT ${has}))`;
  }

  // A scalar list contains a member, as check() reads a list; NULL elements and a NULL list
  // contain nothing. Case-insensitively, its members compare lowered.
  if (resolved.shape === 'list' && rhs.type === 'value') {
    const listLower =
      resolveCaseInsensitive(rule.caseInsensitive) && comparesText('text', rhs.value);
    if (CONTAINS_OPERATORS.includes(rule.operator)) {
      const member = nextParam(state, rhs.value);
      const has = listLower
        ? `EXISTS (SELECT 1 FROM unnest(${field}) AS e WHERE LOWER(e) = LOWER(${member}))`
        : `array_position(${field}, ${member}) IS NOT NULL`;
      return rule.operator === Operator.contains ? has : `NOT ${has}`;
    }
    if (SET_OPERATORS.includes(rule.operator) && Array.isArray(rhs.value))
      return buildCondition(listMembership(rule, rhs.value), state);
    if (withShapeString(rule.operator))
      throw new Error(
        `'${rule.operator}' does not apply to the list '${rule.field}'; test its members with contains.`,
      );
    if (listLower && EQUALITY_OPERATORS.includes(rule.operator) && Array.isArray(rhs.value)) {
      const lowered = nextParam(state, lowerStrings(rhs.value));
      const same = `(${field} IS NOT NULL AND ARRAY(SELECT LOWER(e) FROM unnest(${field}) AS e) = ${lowered})`;
      return rule.operator === Operator.equals ? same : orNullSql(field, `NOT ${same}`);
    }
  }

  // Extract both variants up front so TypeScript doesn't need to narrow inside each case
  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  // A set or a pattern is bound when compiling; one read per row has no SQL form.
  if (
    rhsCol !== undefined &&
    (SET_OPERATORS.includes(rule.operator) || getValueShape(rule.operator, 'field') === 'pattern')
  )
    throw new Error(
      `'${rule.operator}' against an operand read per row ('${rule.path}') has no SQL form; use check().`,
    );

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

    case Operator.notStartsWith:
      return orNull(
        `${lc(field)} NOT LIKE ${lc(nextParam(state, `${escapeLikePattern(String(rhsVal))}%`))}`,
      );

    case Operator.notEndsWith:
      return orNull(
        `${lc(field)} NOT LIKE ${lc(nextParam(state, `%${escapeLikePattern(String(rhsVal))}`))}`,
      );

    case Operator.matches:
      return sqlMatch(field, rhsVal, false, state);

    case Operator.notMatches:
      return orNull(sqlMatch(field, rhsVal, true, state));

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
  return orderPair(readPair(range, rule.operator)).map((value) => {
    const end: ResolvedRhs = { type: 'value', value };
    return rule.offset === undefined ? end : offsetNumber(end, rule.offset, state);
  }) as [ResolvedRhs, ResolvedRhs];
};

/** A pattern as Postgres reads it: its source, and `~*` / `!~*` when case-insensitive. */
const sqlMatch = (field: string, value: unknown, negated: boolean, state: BuilderState): string => {
  if (typeof value !== 'string' && !(value instanceof RegExp))
    throw new Error('matches requires a string or RegExp pattern');
  const { source, caseInsensitive } = readPattern(value);
  return `${field} ${negated ? '!' : ''}~${caseInsensitive ? '*' : ''} ${nextParam(state, postgresSource(source))}`;
};

const NOT_KNOWN = Symbol('not known');

/** A comparison's operand when it is known now — a value, or a range of two values, moved by
 *  a known offset — or NOT_KNOWN when it is read per row. */
const knownOperand = (rule: Rule, state: BuilderState): unknown => {
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

/** A string operator other than containment: a list has no prefix or suffix. */
const withShapeString = (operator: string): boolean =>
  getValueShape(operator, 'field') === 'string' && !CONTAINS_OPERATORS.includes(operator);
