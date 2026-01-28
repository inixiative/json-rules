import type { Rule } from '../types';
import { Operator } from '../operator';
import type { BuilderState } from './types';
import { nextParam, quoteField, escapeLikePattern } from './utils';

export const buildFieldRule = (rule: Rule, state: BuilderState): string => {
  const field = quoteField(rule.field);

  switch (rule.operator) {
    case Operator.equals:
      if (rule.value === null) return `${field} IS NULL`;
      return `${field} = ${nextParam(state, rule.value)}`;

    case Operator.notEquals:
      if (rule.value === null) return `${field} IS NOT NULL`;
      return `${field} <> ${nextParam(state, rule.value)}`;

    case Operator.lessThan:
      return `${field} < ${nextParam(state, rule.value)}`;

    case Operator.lessThanEquals:
      return `${field} <= ${nextParam(state, rule.value)}`;

    case Operator.greaterThan:
      return `${field} > ${nextParam(state, rule.value)}`;

    case Operator.greaterThanEquals:
      return `${field} >= ${nextParam(state, rule.value)}`;

    case Operator.in:
      if (!Array.isArray(rule.value) || rule.value.length === 0) return 'FALSE';
      return `${field} = ANY(${nextParam(state, rule.value)})`;

    case Operator.notIn:
      if (!Array.isArray(rule.value) || rule.value.length === 0) return 'TRUE';
      return `${field} <> ALL(${nextParam(state, rule.value)})`;

    case Operator.contains:
      return `${field} LIKE ${nextParam(state, `%${escapeLikePattern(String(rule.value))}%`)}`;

    case Operator.notContains:
      return `${field} NOT LIKE ${nextParam(state, `%${escapeLikePattern(String(rule.value))}%`)}`;

    case Operator.startsWith:
      return `${field} LIKE ${nextParam(state, `${escapeLikePattern(String(rule.value))}%`)}`;

    case Operator.endsWith:
      return `${field} LIKE ${nextParam(state, `%${escapeLikePattern(String(rule.value))}`)}`;

    case Operator.matches:
      return `${field} ~ ${nextParam(state, rule.value)}`;

    case Operator.notMatches:
      return `${field} !~ ${nextParam(state, rule.value)}`;

    case Operator.between:
      if (!Array.isArray(rule.value) || rule.value.length !== 2) {
        throw new Error('between operator requires an array of two values');
      }
      return `${field} BETWEEN ${nextParam(state, rule.value[0])} AND ${nextParam(state, rule.value[1])}`;

    case Operator.notBetween:
      if (!Array.isArray(rule.value) || rule.value.length !== 2) {
        throw new Error('notBetween operator requires an array of two values');
      }
      return `${field} NOT BETWEEN ${nextParam(state, rule.value[0])} AND ${nextParam(state, rule.value[1])}`;

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
