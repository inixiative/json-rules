import { resolveCaseInsensitive } from '../engineGlobals';
import { hasNoOperand } from '../field';
import { orderPair, splitNull } from '../number';
import { Operator } from '../operator';
import { NEGATED_OPERATORS, NO_VALUE_OPERATORS, RANGE_OPERATORS } from '../operatorCatalog';
import {
  acceptsEmptyString,
  compileFieldLiteral,
  type FieldShape,
  walkWith,
} from '../toPrisma/mapWalk';
import type { Rule } from '../types';
import { compareSql, noOperandSql, ORDERED_SQL, orNull as orNullSql, rangeSql } from './compare';
import { type FieldSql, resolveField, resolveFieldSql } from './join';
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
  // A JSON value compared against a number compares as a number, as check() compares it; one
  // that isn't a number reads NULL.
  const fieldFor = (operand: unknown): string =>
    resolved.shape === 'json-path' && isNumeric(operand)
      ? `CASE WHEN jsonb_typeof(${resolveFieldSql(rule.field, state, { jsonb: true })}) = 'number' THEN (${resolved.sql})::numeric END`
      : resolved.sql;
  // A computed left-hand side is never NULL (an aggregate coalesces): no NULL arms.
  const nullable = lhs === undefined;
  if (RANGE_OPERATORS.includes(rule.operator)) {
    const ends = resolveRange(rule, state);
    return rangeSql(
      fieldFor(ends?.map((end) => (end.type === 'value' ? end.value : undefined))),
      ends,
      rule.operator === Operator.notBetween,
      state,
      nullable,
    );
  }
  const rhs = resolveComparison(rule, state);
  const field = fieldFor(rhs.type === 'value' ? rhs.value : undefined);
  const ordered = ORDERED_SQL[rule.operator];
  if (ordered) return compareSql(field, ordered.symbol, rhs, false, state);
  // Nothing to compare against (see hasNoOperand): no row, or the NULL fields for a negation.
  if (rhs.type === 'value' && hasNoOperand(rule, rhs.value))
    return noOperandSql(field, NEGATED_OPERATORS.includes(rule.operator), nullable);
  const arithmetic = rhs.type === 'column' && rhs.computed === true;
  // Case-insensitive compares text, as check() lowercases only strings.
  const text = (shape: FieldShape | undefined) => shape !== 'scalar' && shape !== 'list';
  const lower =
    resolveCaseInsensitive(rule.caseInsensitive) &&
    text(resolved.shape) &&
    (rhs.type === 'column' ? !arithmetic && text(rhs.shape) : typeof rhs.value === 'string');
  const lc = (expr: string): string => (lower ? `LOWER(${expr})` : expr);

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
      const anyOf = `${field} = ANY(${nextParam(state, values)})`;
      return hasNull ? orNull(anyOf) : anyOf;
    }

    case Operator.notIn: {
      const { values, hasNull } = splitNull(rhsVal);
      if (!values.length) return hasNull ? `${field} IS NOT NULL` : 'TRUE';
      const noneOf = `${field} <> ALL(${nextParam(state, values)})`;
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
      return `${field} ~ ${nextParam(state, rhsVal)}`;

    case Operator.notMatches:
      return orNull(`${field} !~ ${nextParam(state, rhsVal)}`);

    case Operator.isEmpty:
      if (!acceptsEmptyString(rule, state.map, state.currentModel)) return `${field} IS NULL`;
      return `(${field} IS NULL OR ${field} = '')`;

    case Operator.notEmpty:
      if (!acceptsEmptyString(rule, state.map, state.currentModel)) return `${field} IS NOT NULL`;
      return `(${field} IS NOT NULL AND ${field} <> '')`;

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

const isNumeric = (operand: unknown): boolean =>
  typeof operand === 'number' ||
  (Array.isArray(operand) &&
    operand.some((item) => typeof item === 'number') &&
    operand.every((item) => typeof item === 'number' || item === null || item === undefined));
