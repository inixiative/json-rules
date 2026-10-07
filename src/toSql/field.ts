import { resolveCaseInsensitive } from '../engineGlobals';
import { Operator } from '../operator';
import { compileFieldLiteral, walkFieldPath } from '../toPrisma/mapWalk';
import type { FieldMap } from '../toPrisma/types';
import type { NumberOffset, Rule } from '../types';
import { resolveFieldSql } from './join';
import { nextParam } from './params';
import { escapeLikePattern } from './quoting';
import type { BuilderState } from './types';
import { type ResolvedRhs, resolveOffset, resolveRef, shiftNumber } from './valueSource';

// The ''-branch of isEmpty/notEmpty belongs to String (and Json) columns only —
// Postgres rejects '' on a timestamp/integer at parse time (toPrisma's 2.18.3 fix,
// ported). Field map is the authority, a stamped coerceType the fallback; with
// neither, the legacy two-branch shape stays so an untyped String field keeps it.
const fieldWalk = (rule: Pick<Rule, 'field'>, state: BuilderState) =>
  state.map && state.currentModel
    ? walkFieldPath(rule.field, state.map as FieldMap, state.currentModel)
    : undefined;

const directEntry = (rule: Pick<Rule, 'field'>, state: BuilderState) => {
  const walk = fieldWalk(rule, state);
  return walk?.kind === 'direct' ? walk.entry : undefined;
};

const acceptsEmptyString = (rule: Rule, state: BuilderState): boolean => {
  const entry = directEntry(rule, state);
  if (entry) return entry.kind === 'scalar' && (entry.type === 'String' || entry.type === 'Json');
  return (
    rule.coerceType === undefined || rule.coerceType === 'String' || rule.coerceType === 'Json'
  );
};

export const buildFieldRule = (rule: Rule, state: BuilderState): string => {
  if (rule.fuzzy)
    throw new Error('Fuzzy matching has no SQL equivalent — evaluate it in memory with check().');
  const field = resolveFieldSql(rule.field, state);
  const lc = (expr: string): string =>
    resolveCaseInsensitive(rule.caseInsensitive) ? `LOWER(${expr})` : expr;
  if (rule.offset !== undefined) return buildOffsetComparison(rule, field, state);
  const rhs = resolveComparison(rule, state);

  // Extract both variants up front so TypeScript doesn't need to narrow inside each case
  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  // A negated predicate is the complement of its positive form, as check() evaluates it.
  // SQL's three-valued logic makes `col <> $1` NULL — never true — for a NULL column, so
  // every negation carries the NULL rows explicitly.
  const orNull = (expr: string): string => `(${expr} OR ${field} IS NULL)`;

  switch (rule.operator) {
    case Operator.equals:
      if (rhsCol !== undefined) return `${lc(field)} IS NOT DISTINCT FROM ${lc(rhsCol)}`;
      if (rhsVal === null) return `${field} IS NULL`;
      return `${lc(field)} = ${lc(nextParam(state, rhsVal))}`;

    case Operator.notEquals:
      if (rhsCol !== undefined) return `${lc(field)} IS DISTINCT FROM ${lc(rhsCol)}`;
      if (rhsVal === null) return `${field} IS NOT NULL`;
      return orNull(`${lc(field)} <> ${lc(nextParam(state, rhsVal))}`);

    case Operator.lessThan:
      if (rhsCol !== undefined) return `${field} < ${rhsCol}`;
      return `${field} < ${nextParam(state, rhsVal)}`;

    case Operator.lessThanEquals:
      if (rhsCol !== undefined) return `${field} <= ${rhsCol}`;
      return `${field} <= ${nextParam(state, rhsVal)}`;

    case Operator.greaterThan:
      if (rhsCol !== undefined) return `${field} > ${rhsCol}`;
      return `${field} > ${nextParam(state, rhsVal)}`;

    case Operator.greaterThanEquals:
      if (rhsCol !== undefined) return `${field} >= ${rhsCol}`;
      return `${field} >= ${nextParam(state, rhsVal)}`;

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

    case Operator.between: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('between operator requires an array of two values');
      }
      const [min, max] = (v[0] as number) <= (v[1] as number) ? v : [v[1], v[0]];
      return `${field} BETWEEN ${nextParam(state, min)} AND ${nextParam(state, max)}`;
    }

    case Operator.notBetween: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('notBetween operator requires an array of two values');
      }
      const [min, max] = (v[0] as number) <= (v[1] as number) ? v : [v[1], v[0]];
      return orNull(`${field} NOT BETWEEN ${nextParam(state, min)} AND ${nextParam(state, max)}`);
    }

    case Operator.isEmpty:
      if (!acceptsEmptyString(rule, state)) return `${field} IS NULL`;
      return `(${field} IS NULL OR ${field} = '')`;

    case Operator.notEmpty:
      if (!acceptsEmptyString(rule, state)) return `${field} IS NOT NULL`;
      return `(${field} IS NOT NULL AND ${field} <> '')`;

    case Operator.exists:
      return `${field} IS NOT NULL`;

    case Operator.notExists:
      return `${field} IS NULL`;

    default:
      throw new Error(`Unknown operator: ${(rule as Rule).operator}`);
  }
};

const splitNull = (list: unknown): { values: unknown[]; hasNull: boolean } => {
  if (!Array.isArray(list)) return { values: [], hasNull: false };
  const values = list.filter((v) => v !== null);
  return { values, hasNull: values.length !== list.length };
};

/**
 * Resolve the right-hand side of a comparison from a Rule.
 *
 * - rule.value set        → { type: 'value', value }
 * - rule.path = '$.field' → { type: 'column', sql: '"alias"."field"' }  (column-to-column)
 * - rule.path = 'ctx.key' → { type: 'value', value: context[key] }      (external context)
 * - neither set           → { type: 'value', value: undefined } for no-value operators
 */
const resolveComparison = (rule: Rule, state: BuilderState): ResolvedRhs => {
  const rhs = resolveRawComparison(rule, state);
  if (rhs.type === 'column') return rhs;
  return {
    type: 'value',
    value: compileFieldLiteral(rule, rhs.value, fieldWalk(rule, state), 'toSql'),
  };
};

const resolveRawComparison = (rule: Rule, state: BuilderState): ResolvedRhs => {
  if (rule.value !== undefined) {
    return { type: 'value', value: rule.value };
  }

  if (rule.path) return resolveRef(rule.path, state);

  if (rule.bind !== undefined) {
    if (rule.bindOptional === true) return { type: 'value', value: null };
    throw new Error(
      `Unresolved binding '${rule.bind}' for field '${rule.field}' — resolve bindings (resolveLensBindings) before compiling to SQL.`,
    );
  }

  // No value, no path — valid for no-value operators (isEmpty, notEmpty, exists, notExists)
  return { type: 'value', value: undefined };
};

const COMPARATORS: Partial<Record<Operator, string>> = {
  [Operator.equals]: '=',
  [Operator.notEquals]: '<>',
  [Operator.lessThan]: '<',
  [Operator.lessThanEquals]: '<=',
  [Operator.greaterThan]: '>',
  [Operator.greaterThanEquals]: '>=',
};

// An offset compares against arithmetic, so NULL is never the is-null sentinel here: a null
// base or offset makes the comparison NULL — no match — and a negation keeps NULL fields only.
const buildOffsetComparison = (rule: Rule, field: string, state: BuilderState): string => {
  const offset = resolveOffset(rule.offset as NumberOffset, rule.field, state);
  const raw = resolveRawComparison(rule, state);
  const base: ResolvedRhs =
    raw.type === 'column'
      ? raw
      : {
          type: 'value',
          value: compileFieldLiteral(rule, raw.value, fieldWalk(rule, state), 'toSql'),
        };
  const operand = (rhs: ResolvedRhs): string =>
    rhs.type === 'column' ? rhs.sql : nextParam(state, rhs.value);
  const orNull = (expr: string): string => `(${expr} OR ${field} IS NULL)`;

  if (rule.operator === Operator.between || rule.operator === Operator.notBetween) {
    const range = base.type === 'value' ? base.value : undefined;
    const ends =
      range === null
        ? [null, null]
        : Array.isArray(range) && range.length === 2
          ? (range[0] as number) <= (range[1] as number)
            ? range
            : [range[1], range[0]]
          : undefined;
    if (!ends) throw new Error(`${rule.operator} operator requires an array of two values`);
    const [min, max] = ends.map((end) =>
      operand(shiftNumber({ type: 'value', value: end }, offset, state)),
    );
    return rule.operator === Operator.between
      ? `${field} BETWEEN ${min} AND ${max}`
      : orNull(`${field} NOT BETWEEN ${min} AND ${max}`);
  }

  const comparator = COMPARATORS[rule.operator];
  if (!comparator) throw new Error(`offset does not apply to operator '${rule.operator}'`);
  const comparison = `${field} ${comparator} ${operand(shiftNumber(base, offset, state))}`;
  return rule.operator === Operator.notEquals ? orNull(comparison) : comparison;
};
