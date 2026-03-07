import { get } from 'lodash';
import { escapeIdentifier } from 'pg';
import { DateOperator } from '../operator';
import type { DateRule } from '../types';
import { mapDayNames } from './dayNames';
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

    case DateOperator.between: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('between date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(v);
      return `${field} BETWEEN ${nextParam(state, start)} AND ${nextParam(state, end)}`;
    }

    case DateOperator.notBetween: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('notBetween date operator requires an array of two values');
      }
      const [start, end] = normalizeDateRange(v);
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

type ResolvedRhs = { type: 'value'; value: unknown } | { type: 'column'; sql: string };

const resolveDateRhs = (rule: DateRule, state: BuilderState): ResolvedRhs => {
  if (rule.value !== undefined) {
    return { type: 'value', value: rule.value };
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
