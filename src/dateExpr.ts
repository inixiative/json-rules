import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import type {
  DateConfig,
  DateExpr,
  EdgeExpr,
  PeriodExpr,
  PeriodUnit,
  RelativeUnits,
  RollingExpr,
} from './types';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(quarterOfYear);
dayjs.extend(isoWeek);

type ManipulateUnit = 'year' | 'quarter' | 'month' | 'week' | 'day' | 'hour' | 'minute' | 'second';

const UNIT_FOR: Record<keyof RelativeUnits, ManipulateUnit> = {
  years: 'year',
  quarters: 'quarter',
  months: 'month',
  weeks: 'week',
  days: 'day',
  hours: 'hour',
  minutes: 'minute',
  seconds: 'second',
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** True when a DateRule `value` is a structured date expression rather than an absolute date. */
export const isDateExpr = (value: unknown): value is DateExpr => {
  if (!isPlainObject(value)) return false;
  return (
    'ago' in value ||
    'ahead' in value ||
    'this' in value ||
    'last' in value ||
    'next' in value ||
    'start' in value ||
    'end' in value
  );
};

const requireNow = (config: DateConfig): dayjs.Dayjs => {
  if (config.now === undefined)
    throw new Error('date expressions require `now` to be supplied to the evaluator');
  const base = config.timeZone ? dayjs(config.now).tz(config.timeZone) : dayjs(config.now);
  if (!base.isValid()) throw new Error(`invalid \`now\`: ${String(config.now)}`);
  return base;
};

const applyUnits = (base: dayjs.Dayjs, units: RelativeUnits, direction: 1 | -1): dayjs.Dayjs => {
  let result = base;
  for (const key of Object.keys(units) as (keyof RelativeUnits)[]) {
    const magnitude = units[key];
    if (magnitude === undefined) continue;
    if (magnitude < 0) throw new Error(`relative magnitudes must be positive: ${key}=${magnitude}`);
    result = result.add(direction * magnitude, UNIT_FOR[key] as dayjs.QUnitType);
  }
  return result;
};

export const isRollingExpr = (e: DateExpr): e is RollingExpr => 'ago' in e || 'ahead' in e;
export const isPeriodExpr = (e: DateExpr): e is PeriodExpr =>
  'this' in e || 'last' in e || 'next' in e;
export const isEdgeExpr = (e: DateExpr): e is EdgeExpr => 'start' in e || 'end' in e;

// `week` is governed by weekStart (default monday → isoWeek). `isoWeek` is always Monday.
const effectivePeriodUnit = (unit: PeriodUnit, config: DateConfig): dayjs.OpUnitType => {
  if (unit === 'week')
    return (config.weekStart === 'sunday' ? 'week' : 'isoWeek') as dayjs.OpUnitType;
  return unit as dayjs.OpUnitType;
};

/** Resolve a calendar period (this/last/next) to its [start, end] boundaries. */
export const resolvePeriodRange = (
  expr: PeriodExpr,
  config: DateConfig,
): [dayjs.Dayjs, dayjs.Dayjs] => {
  const now = requireNow(config);
  const unit = 'this' in expr ? expr.this : 'last' in expr ? expr.last : expr.next;
  // Step whole periods first, then snap — robust to month-length clamping.
  const stepUnit = (unit === 'isoWeek' ? 'week' : unit) as dayjs.QUnitType;
  let base = now;
  if ('last' in expr) base = now.subtract(1, stepUnit);
  else if ('next' in expr) base = now.add(1, stepUnit);
  const eff = effectivePeriodUnit(unit, config);
  return [base.startOf(eff), base.endOf(eff)];
};

/**
 * Resolve a point expression (for before/after/onOrBefore/onOrAfter).
 * Rolling → the offset instant; edge → the named boundary of a period.
 */
export const resolveDateExpr = (expr: DateExpr, config: DateConfig): dayjs.Dayjs => {
  if (isRollingExpr(expr)) {
    const base = requireNow(config);
    return 'ago' in expr ? applyUnits(base, expr.ago, -1) : applyUnits(base, expr.ahead, 1);
  }
  if (isEdgeExpr(expr)) {
    const period = 'start' in expr ? expr.start : expr.end;
    const [start, end] = resolvePeriodRange(period, config);
    return 'start' in expr ? start : end;
  }
  throw new Error(
    'a point operator requires a rolling or start/end edge expression, not a bare period',
  );
};

/**
 * Resolve a range expression (for `within`).
 * Period → its [start, end]; rolling → [now-Δ, now] / [now, now+Δ].
 */
export const resolveDateExprRange = (
  expr: DateExpr,
  config: DateConfig,
): [dayjs.Dayjs, dayjs.Dayjs] => {
  if (isPeriodExpr(expr)) return resolvePeriodRange(expr, config);
  if (isRollingExpr(expr)) {
    const now = requireNow(config);
    return 'ago' in expr
      ? [applyUnits(now, expr.ago, -1), now]
      : [now, applyUnits(now, expr.ahead, 1)];
  }
  throw new Error('`within` requires a range expression (period or rolling), not an edge point');
};
