import type { DateRule } from '../types';
import { DateOperator } from '../operator';
import type { BuilderState } from './types';
import { nextParam, quoteField, mapDayNames } from './utils';

export const buildDateRule = (rule: DateRule, state: BuilderState): string => {
  const field = quoteField(rule.field);

  switch (rule.dateOperator) {
    case DateOperator.before:
      return `${field} < ${nextParam(state, rule.value)}`;

    case DateOperator.after:
      return `${field} > ${nextParam(state, rule.value)}`;

    case DateOperator.onOrBefore:
      return `${field} <= ${nextParam(state, rule.value)}`;

    case DateOperator.onOrAfter:
      return `${field} >= ${nextParam(state, rule.value)}`;

    case DateOperator.between:
      if (!Array.isArray(rule.value) || rule.value.length !== 2) {
        throw new Error('between date operator requires an array of two values');
      }
      return `${field} BETWEEN ${nextParam(state, rule.value[0])} AND ${nextParam(state, rule.value[1])}`;

    case DateOperator.notBetween:
      if (!Array.isArray(rule.value) || rule.value.length !== 2) {
        throw new Error('notBetween date operator requires an array of two values');
      }
      return `${field} NOT BETWEEN ${nextParam(state, rule.value[0])} AND ${nextParam(state, rule.value[1])}`;

    case DateOperator.dayIn:
      const daysIn = mapDayNames(rule.value);
      return `EXTRACT(DOW FROM ${field}) = ANY(${nextParam(state, daysIn)})`;

    case DateOperator.dayNotIn:
      const daysNotIn = mapDayNames(rule.value);
      return `EXTRACT(DOW FROM ${field}) <> ALL(${nextParam(state, daysNotIn)})`;

    default:
      throw new Error(`Unknown date operator: ${(rule as DateRule).dateOperator}`);
  }
};
