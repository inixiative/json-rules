import { isDateInputValue, parseDateValue, resolveTimeZone } from '../date';
import {
  isDateExpr,
  requireNow,
  resolveDateExprRange,
  resolvePointForOperator,
  rollingShift,
} from '../dateExpr';
import { DateOperator } from '../operator';
import type { DateExpr, DateRule } from '../types';
import { resolveExpr } from '../valueSource';
import { mapDayNames } from './dayNames';
import { resolveFieldSql } from './join';
import { nextParam } from './params';
import type { BuilderState } from './types';
import { type ResolvedRhs, readContext, readsRow, resolveRef, shiftDate } from './valueSource';

export const buildDateRule = (rule: DateRule, state: BuilderState): string => {
  const field = resolveFieldSql(rule.field, state);
  const operand = (rhs: ResolvedRhs): string =>
    rhs.type === 'column' ? rhs.sql : nextParam(state, rhs.value);

  switch (rule.dateOperator) {
    case DateOperator.before:
      return `${field} < ${operand(resolvePoint(rule, state))}`;

    case DateOperator.after:
      return `${field} > ${operand(resolvePoint(rule, state))}`;

    case DateOperator.onOrBefore:
      return `${field} <= ${operand(resolvePoint(rule, state))}`;

    case DateOperator.onOrAfter:
      return `${field} >= ${operand(resolvePoint(rule, state))}`;

    case DateOperator.notBefore:
      return `(${field} >= ${operand(resolvePoint(rule, state))} OR ${field} IS NULL)`;

    case DateOperator.notAfter:
      return `(${field} <= ${operand(resolvePoint(rule, state))} OR ${field} IS NULL)`;

    case DateOperator.within:
      return rangeSql(field, resolveWindow(rule, state), false, operand);

    case DateOperator.notWithin:
      return rangeSql(field, resolveWindow(rule, state), true, operand);

    case DateOperator.between:
      return rangeSql(field, resolveRange(rule, state), false, operand);

    case DateOperator.notBetween:
      return rangeSql(field, resolveRange(rule, state), true, operand);

    case DateOperator.dayIn: {
      if (!Array.isArray(rule.value)) {
        throw new Error('dayIn operator requires an array of day names');
      }
      const days = mapDayNames(rule.value.map((day) => String(day)));
      return `EXTRACT(DOW FROM ${zonedDay(field, state)}) = ANY(${nextParam(state, days)})`;
    }

    case DateOperator.dayNotIn: {
      if (!Array.isArray(rule.value)) {
        throw new Error('dayNotIn operator requires an array of day names');
      }
      const days = mapDayNames(rule.value.map((day) => String(day)));
      return `(EXTRACT(DOW FROM ${zonedDay(field, state)}) <> ALL(${nextParam(state, days)}) OR ${field} IS NULL)`;
    }

    default:
      throw new Error(`Unknown date operator: ${(rule as DateRule).dateOperator}`);
  }
};

// A range whose ends are parameters keeps the plain BETWEEN (the ends were sorted when
// resolved). An end computed per row can't be sorted ahead of time and may read NULL, so it
// compiles SYMMETRIC, and its complement requires both ends — a missing end matches nothing,
// as in check(), and only NULL fields keep the negation.
const rangeSql = (
  field: string,
  [start, end]: [ResolvedRhs, ResolvedRhs],
  negated: boolean,
  operand: (rhs: ResolvedRhs) => string,
): string => {
  const a = operand(start);
  const b = operand(end);
  const perRow = start.type === 'column' || end.type === 'column';
  if (!negated) return `${field} BETWEEN ${perRow ? 'SYMMETRIC ' : ''}${a} AND ${b}`;
  if (!perRow) return `(${field} NOT BETWEEN ${a} AND ${b} OR ${field} IS NULL)`;
  return `((${field} NOT BETWEEN SYMMETRIC ${a} AND ${b} AND ${a} IS NOT NULL AND ${b} IS NOT NULL) OR ${field} IS NULL)`;
};

const zonedDay = (field: string, state: BuilderState): string =>
  `(${field} AT TIME ZONE 'UTC' AT TIME ZONE ${nextParam(state, resolveTimeZone(state.dateConfig ?? {}))})`;

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

// The comparison value before any offset: a literal or expression, a context value, a row
// column (`$.`), or an unresolved bind — null when optional, an error otherwise.
const resolveSource = (rule: DateRule, state: BuilderState): ResolvedRhs => {
  if (rule.value !== undefined) return { type: 'value', value: rule.value };
  if (rule.path) return resolveRef(rule.path, state);
  if (rule.bind !== undefined) {
    if (rule.bindOptional === true) return { type: 'value', value: null };
    throw new Error(
      `Unresolved binding '${rule.bind}' for field '${rule.field}' — resolve bindings (resolveLensBindings) before compiling to SQL.`,
    );
  }
  throw new Error('No value or path specified for date comparison');
};

const nowOperand = (state: BuilderState): ResolvedRhs => ({
  type: 'value',
  value: requireNow(state.dateConfig ?? {}).toDate(),
});

// An expression as one point. A magnitude read per row compiles to `now ± interval`; one read
// from context resolves to its instant, and null when it reads nothing.
const expressionPoint = (expr: DateExpr, operator: string, state: BuilderState): ResolvedRhs => {
  const rolling = rollingShift(expr);
  if (rolling && readsRow(rolling[0])) return shiftDate(nowOperand(state), ...rolling, state);
  const resolved = resolveExpr(expr, readContext(state));
  if (resolved === null) return { type: 'value', value: null };
  return {
    type: 'value',
    value: resolvePointForOperator(resolved, operator, state.dateConfig ?? {}).toDate(),
  };
};

const toPoint = (value: unknown, operator: string, state: BuilderState): ResolvedRhs => {
  if (value === null || value === undefined) return { type: 'value', value: null };
  if (isDateExpr(value)) return expressionPoint(value, operator, state);
  return { type: 'value', value: coerceDateLiteral(value, state) };
};

const applyOffset = (rhs: ResolvedRhs, rule: DateRule, state: BuilderState): ResolvedRhs => {
  if (rule.offset === undefined) return rhs;
  const rolling = rollingShift(rule.offset);
  if (!rolling) throw new Error('a date offset is { ago } or { ahead }');
  return shiftDate(rhs, ...rolling, state);
};

const resolvePoint = (rule: DateRule, state: BuilderState): ResolvedRhs => {
  const source = resolveSource(rule, state);
  const point = source.type === 'column' ? source : toPoint(source.value, rule.dateOperator, state);
  return applyOffset(point, rule, state);
};

// within / notWithin: the range a period or rolling window spans. A rolling magnitude read per
// row compiles to `[now − interval, now]` / `[now, now + interval]`.
const resolveWindow = (rule: DateRule, state: BuilderState): [ResolvedRhs, ResolvedRhs] => {
  const source = resolveSource(rule, state);
  if (source.type === 'value' && (source.value === null || source.value === undefined))
    return [source, source];
  if (source.type === 'column' || !isDateExpr(source.value))
    throw new Error(`${rule.dateOperator} date operator requires a range date expression`);
  const expr = source.value;
  const rolling = rollingShift(expr);
  if (rolling && readsRow(rolling[0])) {
    const now = nowOperand(state);
    const moved = shiftDate(now, ...rolling, state);
    return rolling[1] === -1 ? [moved, now] : [now, moved];
  }
  const resolved = resolveExpr(expr, readContext(state));
  if (resolved === null)
    return [
      { type: 'value', value: null },
      { type: 'value', value: null },
    ];
  const [start, end] = resolveDateExprRange(resolved, state.dateConfig ?? {});
  return [
    { type: 'value', value: start.toDate() },
    { type: 'value', value: end.toDate() },
  ];
};

// between / notBetween: a literal or context pair, sorted, then each end offset.
const resolveRange = (rule: DateRule, state: BuilderState): [ResolvedRhs, ResolvedRhs] => {
  const source = resolveSource(rule, state);
  if (source.type === 'value' && (source.value === null || source.value === undefined))
    return [source, source];
  const raw = source.type === 'value' ? source.value : undefined;
  if (!Array.isArray(raw) || raw.length !== 2) {
    throw new Error(`${rule.dateOperator} date operator requires an array of two values`);
  }
  const missing: [ResolvedRhs, ResolvedRhs] = [
    { type: 'value', value: null },
    { type: 'value', value: null },
  ];
  const isMissing = (end: ResolvedRhs) =>
    end.type === 'value' && (end.value === null || end.value === undefined);
  const [first, second] = raw.map((el) => toPoint(el, rule.dateOperator, state));
  if (isMissing(first) || isMissing(second)) return missing;
  const ordered =
    first.type === 'value' && second.type === 'value'
      ? (normalizeDateRange([first.value, second.value]).map((value) => ({
          type: 'value',
          value,
        })) as [ResolvedRhs, ResolvedRhs])
      : ([first, second] as [ResolvedRhs, ResolvedRhs]);
  const shifted = ordered.map((end) => applyOffset(end, rule, state));
  return shifted.some(isMissing) ? missing : (shifted as [ResolvedRhs, ResolvedRhs]);
};
