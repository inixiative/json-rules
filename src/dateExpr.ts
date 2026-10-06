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

export const requireNow = (config: DateConfig): dayjs.Dayjs => {
  if (config.now === undefined)
    throw new Error('date expressions require `now` to be supplied to the evaluator');
  // Only a literal zone string anchors `now` here; the bind form is resolved upstream (in
  // checkDate, which normalizes config.timeZone to a concrete string) — there are no
  // bindings at this layer (compilers), so a non-string zone means "no static anchor".
  const zone = typeof config.timeZone === 'string' ? config.timeZone : undefined;
  const base = zone ? dayjs(config.now).tz(zone) : dayjs(config.now);
  if (!base.isValid()) throw new Error(`invalid \`now\`: ${String(config.now)}`);
  return base;
};

// Units apply as Postgres applies an interval: the month part (years, quarters, months), then
// the day part (weeks, days), then time — so a shift lands on the same instant in check() and
// in toSql at a month end (2024-02-29 + 1 year 1 month is 2025-03-29, not 2025-03-28).
const MONTHS: Partial<Record<keyof RelativeUnits, number>> = { years: 12, quarters: 3, months: 1 };
const DAYS: Partial<Record<keyof RelativeUnits, number>> = { weeks: 7, days: 1 };
const SECONDS: Partial<Record<keyof RelativeUnits, number>> = {
  hours: 3600,
  minutes: 60,
  seconds: 1,
};

const sumUnits = (units: RelativeUnits, scale: Partial<Record<keyof RelativeUnits, number>>) => {
  let total = 0;
  for (const [key, factor] of Object.entries(scale) as [keyof RelativeUnits, number][]) {
    const magnitude = units[key];
    if (magnitude === undefined) continue;
    if (typeof magnitude !== 'number')
      throw new Error(`unresolved magnitude path '${magnitude.path}' for ${key}`);
    if (magnitude < 0) throw new Error(`relative magnitudes must be positive: ${key}=${magnitude}`);
    total += magnitude * factor;
  }
  return total;
};

/** Move `base` by `units` — forward for `ahead` (1), back for `ago` (-1). */
export const shiftByUnits = (
  base: dayjs.Dayjs,
  units: RelativeUnits,
  direction: 1 | -1,
): dayjs.Dayjs => {
  const months = sumUnits(units, MONTHS);
  const days = sumUnits(units, DAYS);
  const seconds = sumUnits(units, SECONDS);
  let result = base;
  if (months) result = result.add(direction * months, 'month');
  if (days) result = result.add(direction * days, 'day');
  if (seconds) result = result.add(direction * seconds * 1000, 'millisecond');
  return result;
};

export const isRollingExpr = (e: DateExpr): e is RollingExpr => 'ago' in e || 'ahead' in e;
/** A rolling expression's units and direction: `ago` moves back (-1), `ahead` forward (1). */
export const rollingShift = (expr: DateExpr): [RelativeUnits, 1 | -1] | null =>
  isRollingExpr(expr) ? ('ago' in expr ? [expr.ago, -1] : [expr.ahead, 1]) : null;

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
    return 'ago' in expr ? shiftByUnits(base, expr.ago, -1) : shiftByUnits(base, expr.ahead, 1);
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
 * Resolve the single comparison point for before/after/onOrBefore/onOrAfter.
 * Bare period → implied edge (before/onOrBefore → start; after/onOrAfter → end).
 * Rolling/edge → their point. Shared by check, toPrisma, and toSql.
 */
export const resolvePointForOperator = (
  expr: DateExpr,
  operator: string,
  config: DateConfig,
): dayjs.Dayjs => {
  if (isPeriodExpr(expr)) {
    const [start, end] = resolvePeriodRange(expr, config);
    // A complement anchors to the same edge as its positive form: notBefore is the start.
    return operator === 'before' || operator === 'onOrBefore' || operator === 'notBefore'
      ? start
      : end;
  }
  return resolveDateExpr(expr, config);
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
      ? [shiftByUnits(now, expr.ago, -1), now]
      : [now, shiftByUnits(now, expr.ahead, 1)];
  }
  throw new Error('`within` requires a range expression (period or rolling), not an edge point');
};
