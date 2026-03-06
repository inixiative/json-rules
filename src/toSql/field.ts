import { get } from 'lodash';
import { escapeIdentifier } from 'pg';
import type { Rule } from '../types';
import { Operator } from '../operator';
import type { BuilderState } from './types';
import { nextParam, quoteField, escapeLikePattern, resolveFieldSql } from './utils';

export const buildFieldRule = (rule: Rule, state: BuilderState): string => {
  const field = resolveFieldSql(rule.field, state);
  const rhs = resolveComparison(rule, state);

  // Extract both variants up front so TypeScript doesn't need to narrow inside each case
  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  switch (rule.operator) {
    case Operator.equals:
      if (rhsCol !== undefined) return `${field} = ${rhsCol}`;
      if (rhsVal === null) return `${field} IS NULL`;
      return `${field} = ${nextParam(state, rhsVal)}`;

    case Operator.notEquals:
      if (rhsCol !== undefined) return `${field} <> ${rhsCol}`;
      if (rhsVal === null) return `${field} IS NOT NULL`;
      return `${field} <> ${nextParam(state, rhsVal)}`;

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

    case Operator.in:
      if (!Array.isArray(rhsVal) || rhsVal.length === 0) return 'FALSE';
      return `${field} = ANY(${nextParam(state, rhsVal)})`;

    case Operator.notIn:
      if (!Array.isArray(rhsVal) || rhsVal.length === 0) return 'TRUE';
      return `${field} <> ALL(${nextParam(state, rhsVal)})`;

    case Operator.contains:
      return `${field} LIKE ${nextParam(state, `%${escapeLikePattern(String(rhsVal))}%`)}`;

    case Operator.notContains:
      return `${field} NOT LIKE ${nextParam(state, `%${escapeLikePattern(String(rhsVal))}%`)}`;

    case Operator.startsWith:
      return `${field} LIKE ${nextParam(state, `${escapeLikePattern(String(rhsVal))}%`)}`;

    case Operator.endsWith:
      return `${field} LIKE ${nextParam(state, `%${escapeLikePattern(String(rhsVal))}`)}`;

    case Operator.matches:
      return `${field} ~ ${nextParam(state, rhsVal)}`;

    case Operator.notMatches:
      return `${field} !~ ${nextParam(state, rhsVal)}`;

    case Operator.between: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('between operator requires an array of two values');
      }
      return `${field} BETWEEN ${nextParam(state, v[0])} AND ${nextParam(state, v[1])}`;
    }

    case Operator.notBetween: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error('notBetween operator requires an array of two values');
      }
      return `${field} NOT BETWEEN ${nextParam(state, v[0])} AND ${nextParam(state, v[1])}`;
    }

    case Operator.isEmpty:
      return `(${field} IS NULL OR ${field} = '')`;

    case Operator.notEmpty:
      return `(${field} IS NOT NULL AND ${field} <> '')`;

    case Operator.exists:
      return `${field} IS NOT NULL`;

    case Operator.notExists:
      return `${field} IS NULL`;

    default:
      throw new Error(`Unknown operator: ${(rule as Rule).operator}`);
  }
};

type ResolvedRhs =
  | { type: 'value'; value: unknown }
  | { type: 'column'; sql: string };

/**
 * Resolve the right-hand side of a comparison from a Rule.
 *
 * - rule.value set        → { type: 'value', value }
 * - rule.path = '$.field' → { type: 'column', sql: '"alias"."field"' }  (column-to-column)
 * - rule.path = 'ctx.key' → { type: 'value', value: context[key] }      (external context)
 * - neither set           → { type: 'value', value: undefined } for no-value operators
 */
const resolveComparison = (rule: Rule, state: BuilderState): ResolvedRhs => {
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
        `BuilderState.context is required to resolve path '${rule.path}'. ` +
          `Pass context in options when calling toSql().`,
      );
    }
    return { type: 'value', value: get(state.context, rule.path) };
  }

  // No value, no path — valid for no-value operators (isEmpty, notEmpty, exists, notExists)
  return { type: 'value', value: undefined };
};
