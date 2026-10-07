import { resolveExpr } from '../amount';
import { coerceDateLiteral, dayNumbers } from '../date';
import {
  isDateExpr,
  requireNow,
  resolveDateExprRange,
  resolvePointForOperator,
  rollingShift,
} from '../dateExpr';
import { orderPair } from '../number';
import { DateOperator } from '../operator';
import type { DateExpr, DateRule } from '../types';
import { compareSql, noOperandSql, ORDERED_SQL, orNull, rangeSql } from './compare';
import { resolveFieldSql } from './join';
import { offsetDate } from './offset';
import { nextParam } from './params';
import { asInstant, readsRow, shiftDate } from './shift';
import type { BuilderState } from './types';
import {
  compileTimeRead,
  dateConfigOf,
  isMissing,
  NO_VALUE,
  type ResolvedRhs,
  resolveSource,
} from './valueSource';

export const buildDateRule = (rule: DateRule, state: BuilderState): string => {
  const field = resolveFieldSql(rule.field, state);
  const ordered = ORDERED_SQL[rule.dateOperator];
  if (ordered)
    return compareSql(field, ordered.symbol, resolvePoint(rule, state), !!ordered.negated, state);

  switch (rule.dateOperator) {
    case DateOperator.within:
    case DateOperator.notWithin:
      return rangeSql(
        field,
        resolveWindow(rule, state),
        rule.dateOperator === DateOperator.notWithin,
        state,
      );

    case DateOperator.between:
    case DateOperator.notBetween:
      return rangeSql(
        field,
        resolveRange(rule, state),
        rule.dateOperator === DateOperator.notBetween,
        state,
      );

    case DateOperator.dayIn:
    case DateOperator.dayNotIn: {
      const negated = rule.dateOperator === DateOperator.dayNotIn;
      const source = resolveSource(rule, state);
      if (source.type === 'column')
        throw new Error(
          `A weekday list read from the row ('${rule.path}') is not supported by toSql()`,
        );
      const numbers = dayNumbers(source.value);
      if (numbers === null) return noOperandSql(field, negated);
      const zone = nextParam(state, dateConfigOf(state).timeZone);
      const days = nextParam(state, numbers);
      const dow = `EXTRACT(DOW FROM (${asInstant(field)} AT TIME ZONE ${zone}))`;
      return rule.dateOperator === DateOperator.dayIn
        ? `${dow} = ANY(${days})`
        : orNull(field, `${dow} <> ALL(${days})`);
    }

    default:
      throw new Error(`Unknown date operator: ${(rule as DateRule).dateOperator}`);
  }
};

const nowOperand = (state: BuilderState): ResolvedRhs => ({
  type: 'value',
  value: requireNow(dateConfigOf(state)).toDate(),
});

const expressionPoint = (expr: DateExpr, operator: string, state: BuilderState): ResolvedRhs => {
  const rolling = rollingShift(expr);
  if (rolling && readsRow(rolling[0])) return shiftDate(nowOperand(state), ...rolling, state);
  const resolved = resolveExpr(expr, compileTimeRead(state));
  if (resolved === null) return NO_VALUE;
  return {
    type: 'value',
    value: resolvePointForOperator(resolved, operator, dateConfigOf(state)).toDate(),
  };
};

const toPoint = (value: unknown, operator: string, state: BuilderState): ResolvedRhs => {
  if (value === null || value === undefined) return NO_VALUE;
  if (isDateExpr(value)) return expressionPoint(value, operator, state);
  return { type: 'value', value: coerceDateLiteral(value, dateConfigOf(state).timeZone) };
};

const withOffset = (rhs: ResolvedRhs, rule: DateRule, state: BuilderState): ResolvedRhs =>
  rule.offset === undefined ? rhs : offsetDate(rhs, rule.offset, state);

const resolvePoint = (rule: DateRule, state: BuilderState): ResolvedRhs => {
  const source = resolveSource(rule, state);
  const point = source.type === 'column' ? source : toPoint(source.value, rule.dateOperator, state);
  return withOffset(point, rule, state);
};

const resolveWindow = (rule: DateRule, state: BuilderState): [ResolvedRhs, ResolvedRhs] | null => {
  const source = resolveSource(rule, state);
  if (isMissing(source)) return null;
  if (source.type === 'column' || !isDateExpr(source.value))
    throw new Error(`${rule.dateOperator} date operator requires a range date expression`);
  const rolling = rollingShift(source.value);
  if (rolling && readsRow(rolling[0])) {
    const now = nowOperand(state);
    const moved = shiftDate(now, ...rolling, state);
    return rolling[1] === -1 ? [moved, now] : [now, moved];
  }
  const resolved = resolveExpr(source.value, compileTimeRead(state));
  if (resolved === null) return null;
  const ends = resolveDateExprRange(resolved, dateConfigOf(state));
  return [
    { type: 'value', value: ends[0].toDate() },
    { type: 'value', value: ends[1].toDate() },
  ];
};

const resolveRange = (rule: DateRule, state: BuilderState): [ResolvedRhs, ResolvedRhs] | null => {
  const source = resolveSource(rule, state);
  if (isMissing(source)) return null;
  const raw = source.type === 'value' ? source.value : undefined;
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error(`${rule.dateOperator} date operator requires an array of two values`);
  }
  const points = raw.map((el) => toPoint(el, rule.dateOperator, state));
  if (points.some(isMissing)) return null;
  const [first, second] = points;
  const ends: ResolvedRhs[] =
    first.type === 'value' && second.type === 'value'
      ? orderPair([first.value as Date, second.value as Date]).map((value) => ({
          type: 'value' as const,
          value,
        }))
      : points;
  return ends.map((end) => withOffset(end, rule, state)) as [ResolvedRhs, ResolvedRhs];
};
