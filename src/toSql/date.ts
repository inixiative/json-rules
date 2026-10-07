import { resolveExpr } from '../amount';
import { coerceDateLiteral, dayNumbers } from '../date';
import {
  isDateExpr,
  requireNow,
  resolveDateExprRange,
  resolvePointForOperator,
  rollingShift,
} from '../dateExpr';
import { orderPair, readPair } from '../number';
import { DateOperator } from '../operator';
import type { DateExpr, DateRule } from '../types';
import { compareSql, noOperandSql, orderedSql, orNull, rangeSql } from './compare';
import { type FieldSql, resolveField } from './join';
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

// A known bound binds as an ISO instant, which compares against the column as stored. A bound
// read per row, or a date stored as text, compares as instants on both sides — independent of
// the column types and the session zone.
const asOperand = (rhs: ResolvedRhs, state: BuilderState): ResolvedRhs =>
  rhs.type === 'column' && !rhs.computed
    ? { type: 'column', sql: asInstant(rhs, state), computed: true }
    : rhs;

const sides = (
  field: FieldSql,
  ends: ResolvedRhs[],
  state: BuilderState,
): { lhs: string; ends: ResolvedRhs[] } => {
  const perRow = ends.some((end) => end.type === 'column');
  const text = field.shape === 'json-path' || field.shape === 'text';
  return perRow || text
    ? { lhs: asInstant(field, state), ends: ends.map((end) => asOperand(end, state)) }
    : { lhs: field.sql, ends };
};

export const buildDateRule = (rule: DateRule, state: BuilderState): string => {
  const field = resolveField(rule.field, state);
  const ordered = orderedSql(rule.dateOperator, 'date');
  if (ordered) {
    const { lhs, ends } = sides(field, [resolvePoint(rule, state)], state);
    return compareSql(lhs, ordered.symbol, ends[0], ordered.negated, state);
  }

  const range = (pair: [ResolvedRhs, ResolvedRhs] | null, negated: boolean): string => {
    if (!pair) return rangeSql(field.sql, null, negated, state);
    const { lhs, ends } = sides(field, pair, state);
    return rangeSql(lhs, ends as [ResolvedRhs, ResolvedRhs], negated, state);
  };

  switch (rule.dateOperator) {
    case DateOperator.within:
    case DateOperator.notWithin:
      return range(resolveWindow(rule, state), rule.dateOperator === DateOperator.notWithin);

    case DateOperator.between:
    case DateOperator.notBetween:
      return range(resolveRange(rule, state), rule.dateOperator === DateOperator.notBetween);

    case DateOperator.dayIn:
    case DateOperator.dayNotIn: {
      const negated = rule.dateOperator === DateOperator.dayNotIn;
      const source = resolveSource(rule, state);
      if (source.type === 'column')
        throw new Error(
          `A weekday list read from the row ('${rule.path}') is not supported by toSql()`,
        );
      const numbers = dayNumbers(source.value);
      if (numbers === null) return noOperandSql(field.sql, negated);
      const zone = nextParam(state, dateConfigOf(state).timeZone);
      const days = nextParam(state, numbers);
      const dow = `EXTRACT(DOW FROM (${asInstant(field, state)} AT TIME ZONE ${zone}))`;
      return rule.dateOperator === DateOperator.dayIn
        ? `${dow} = ANY(${days})`
        : orNull(field.sql, `${dow} <> ALL(${days})`);
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
  const points = readPair(raw, rule.dateOperator).map((el) =>
    toPoint(el, rule.dateOperator, state),
  );
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
