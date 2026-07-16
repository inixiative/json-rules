import { get } from 'lodash-es';
import { isDateInputValue, parseDateValue, resolveTimeZone } from '../date';
import {
  isDateExpr,
  resolveDateExpr,
  resolveDateExprRange,
  resolvePointForOperator,
} from '../dateExpr';
import { DateOperator } from '../operator';
import type { DateRule } from '../types';
import { mapDayNames } from './dayNames';
import { escapeIdentifier } from './escape';
import { resolveFieldSql } from './join';
import { nextParam } from './params';
import { quoteField } from './quoting';
import type { BuilderState } from './types';

export const buildDateRule = (rule: DateRule, state: BuilderState): string => {
  const field = resolveFieldSql(rule.field, state);
  const rhs = resolveDateRhs(rule, state);

  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  switch (rule.dateOperator) {
    case DateOperator.before:
      if (rhsCol !== undefined) return `${field} < ${rhsCol}`;
      return `${field} < ${nextParam(state, rhsVal)}`;

    case DateOperator.after:
      if (rhsCol !== undefined) return `${field} > ${rhsCol}`;
      return `${field} > ${nextParam(state, rhsVal)}`;

    case DateOperator.onOrBefore:
      if (rhsCol !== undefined) return `${field} <= ${rhsCol}`;
      return `${field} <= ${nextParam(state, rhsVal)}`;

    case DateOperator.onOrAfter:
      if (rhsCol !== undefined) return `${field} >= ${rhsCol}`;
      return `${field} >= ${nextParam(state, rhsVal)}`;

    case DateOperator.within: {
      if (!isDateExpr(rule.value))
        throw new Error('within date operator requires a range date expression');
      const [start, end] = resolveDateExprRange(rule.value, state.dateConfig ?? {});
      return `${field} BETWEEN ${nextParam(state, start.toDate())} AND ${nextParam(state, end.toDate())}`;
    }

    case DateOperator.between: {
      const raw = rhsVal;
      if (!Array.isArray(raw) || raw.length !== 2) {
        throw new Error('between date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(raw.map(resolveDateElem(state)));
      return `${field} BETWEEN ${nextParam(state, start)} AND ${nextParam(state, end)}`;
    }

    case DateOperator.notBetween: {
      const raw = rhsVal;
      if (!Array.isArray(raw) || raw.length !== 2) {
        throw new Error('notBetween date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(raw.map(resolveDateElem(state)));
      return `${field} NOT BETWEEN ${nextParam(state, start)} AND ${nextParam(state, end)}`;
    }

    case DateOperator.dayIn: {
      if (!Array.isArray(rule.value)) {
        throw new Error('dayIn operator requires an array of day names');
      }
      const days = mapDayNames(rule.value.map((day) => String(day)));
      return `EXTRACT(DOW FROM ${field}) = ANY(${nextParam(state, days)})`;
    }

    case DateOperator.dayNotIn: {
      if (!Array.isArray(rule.value)) {
        throw new Error('dayNotIn operator requires an array of day names');
      }
      const days = mapDayNames(rule.value.map((day) => String(day)));
      return `EXTRACT(DOW FROM ${field}) <> ALL(${nextParam(state, days)})`;
    }

    default:
      throw new Error(`Unknown date operator: ${(rule as DateRule).dateOperator}`);
  }
};

const normalizeDateRange = (value: unknown[]): [unknown, unknown] => {
  const [first, second] = value;
  return compareDateValues(first, second) <= 0 ? [first, second] : [second, first];
};

const compareDateValues = (left: unknown, right: unknown): number => {
  const lhs = normalizeComparableDateValue(left);
  const rhs = normalizeComparableDateValue(right);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
};

const normalizeComparableDateValue = (value: unknown): string | number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
};

// Same parse-and-anchor seam check() uses (naive strings → midnight in the resolved
// zone; instants as-is), emitted as concrete Dates so the SQL param carries the same
// instant a re-run check() would compare against.
const coerceDateLiteral = (value: unknown, state: BuilderState): unknown => {
  if (value === undefined || !isDateInputValue(value)) return value;
  const parsed = parseDateValue(value, resolveTimeZone(state.dateConfig ?? {}));
  if (!parsed.isValid()) throw new Error(`Invalid date value: ${String(value)}`);
  return parsed.toDate();
};

const resolveDateElem =
  (state: BuilderState) =>
  (el: unknown): unknown =>
    isDateExpr(el)
      ? resolveDateExpr(el, state.dateConfig ?? {}).toDate()
      : coerceDateLiteral(el, state);

type ResolvedRhs = { type: 'value'; value: unknown } | { type: 'column'; sql: string };

const resolveDateRhs = (rule: DateRule, state: BuilderState): ResolvedRhs => {
  if (rule.value !== undefined) {
    // Point expressions resolve to a concrete Date at compile time (operator-aware
    // implied edges). `within` is handled separately in the switch.
    if (isDateExpr(rule.value) && rule.dateOperator !== DateOperator.within) {
      return {
        type: 'value',
        value: resolvePointForOperator(
          rule.value,
          rule.dateOperator,
          state.dateConfig ?? {},
        ).toDate(),
      };
    }
    // Arrays (between pairs, dayIn day names) are handled per-operator in the switch.
    return {
      type: 'value',
      value: Array.isArray(rule.value) ? rule.value : coerceDateLiteral(rule.value, state),
    };
  }

  if (rule.path) {
    if (rule.path.startsWith('$.')) {
      const refField = rule.path.substring(2);
      const sql = state.currentAlias
        ? `${escapeIdentifier(state.currentAlias)}.${escapeIdentifier(refField)}`
        : quoteField(refField);
      return { type: 'column', sql };
    }

    if (!state.context) {
      throw new Error(
        `BuilderState.context is required to resolve date path '${rule.path}'. ` +
          `Pass context in options when calling toSql().`,
      );
    }
    return { type: 'value', value: get(state.context, rule.path) };
  }

  return { type: 'value', value: undefined };
};
