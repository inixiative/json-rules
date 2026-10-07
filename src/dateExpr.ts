import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek.js';
import quarterOfYear from 'dayjs/plugin/quarterOfYear.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { isPlainObject } from 'lodash-es';
import { type INTERVAL_FIELDS, RELATIVE_UNITS, type RelativeUnit } from './operatorCatalog';
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

/** True when a DateRule `value` is a structured date expression rather than an absolute date. */
export const isDateExpr = (value: unknown): value is DateExpr => {
  if (!isPlainObject(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    'ago' in v ||
    'ahead' in v ||
    'this' in v ||
    'last' in v ||
    'next' in v ||
    'start' in v ||
    'end' in v
  );
};

/** The zone an evaluation reads in when none is set: never the host's. */
export const DEFAULT_ZONE = 'UTC';

/** A date config with its zone read: the expression layer never sees a value source. */
export type ResolvedDateConfig = Omit<DateConfig, 'timeZone'> & { timeZone: string };

export const requireNow = (config: ResolvedDateConfig): dayjs.Dayjs => {
  if (config.now === undefined)
    throw new Error('date expressions require `now` to be supplied to the evaluator');
  const base = dayjs(config.now).tz(config.timeZone);
  if (!base.isValid()) throw new Error(`invalid \`now\`: ${String(config.now)}`);
  return base;
};

// Units apply as Postgres applies an interval to a wall-clock time: the month part (years,
// quarters, months), then the day part (weeks, days), then time — so a shift lands on the same
// instant in check() and in toSql, at a month end (2024-02-29 + 1 year 1 month is 2025-03-29)
// and across a DST change in the evaluation's zone (a day is 23 hours on the spring-forward day).
/** The units' total in one Postgres interval field (months, days or secs). */
export const intervalTotal = (
  units: RelativeUnits<number>,
  field: (typeof INTERVAL_FIELDS)[number],
): number =>
  (Object.entries(units) as [RelativeUnit, number][]).reduce(
    (total, [unit, amount]) =>
      RELATIVE_UNITS[unit].interval === field
        ? total + amount * RELATIVE_UNITS[unit].factor
        : total,
    0,
  );

const WALL = 'YYYY-MM-DDTHH:mm:ss.SSS';

/** Move `base` by `units` on the wall clock of `zone` — forward for `ahead` (1), back for `ago` (-1). */
export const shiftByUnits = (
  base: dayjs.Dayjs,
  units: RelativeUnits<number>,
  direction: 1 | -1,
  zone: string,
): dayjs.Dayjs => {
  const months = intervalTotal(units, 'months');
  const days = intervalTotal(units, 'days');
  const seconds = intervalTotal(units, 'secs');
  let wall = dayjs.utc(base.tz(zone).format(WALL));
  if (months) wall = wall.add(direction * months, 'month');
  if (days) wall = wall.add(direction * days, 'day');
  if (seconds) wall = wall.add(direction * seconds * 1000, 'millisecond');
  return dayjs.tz(wall.format(WALL), zone);
};

export const isRollingExpr = <A>(e: DateExpr<A>): e is RollingExpr<A> => 'ago' in e || 'ahead' in e;
/** A rolling expression's units and direction: `ago` moves back (-1), `ahead` forward (1). */
export const rollingShift = <A>(expr: DateExpr<A>): [RelativeUnits<A>, 1 | -1] | null =>
  isRollingExpr(expr) ? ('ago' in expr ? [expr.ago, -1] : [expr.ahead, 1]) : null;

export const isPeriodExpr = <A>(e: DateExpr<A>): e is PeriodExpr =>
  'this' in e || 'last' in e || 'next' in e;
export const isEdgeExpr = <A>(e: DateExpr<A>): e is EdgeExpr => 'start' in e || 'end' in e;

// `week` is governed by weekStart (default monday → isoWeek). `isoWeek` is always Monday.
const effectivePeriodUnit = (unit: PeriodUnit, config: ResolvedDateConfig): dayjs.OpUnitType => {
  if (unit === 'week')
    return (config.weekStart === 'sunday' ? 'week' : 'isoWeek') as dayjs.OpUnitType;
  return unit as dayjs.OpUnitType;
};

/** Resolve a calendar period (this/last/next) to its [start, end] boundaries. */
export const resolvePeriodRange = (
  expr: PeriodExpr,
  config: ResolvedDateConfig,
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
export const resolveDateExpr = (
  expr: DateExpr<number>,
  config: ResolvedDateConfig,
): dayjs.Dayjs => {
  const rolling = rollingShift(expr);
  if (rolling) return shiftByUnits(requireNow(config), ...rolling, config.timeZone);
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
  expr: DateExpr<number>,
  operator: string,
  config: ResolvedDateConfig,
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
  expr: DateExpr<number>,
  config: ResolvedDateConfig,
): [dayjs.Dayjs, dayjs.Dayjs] => {
  if (isPeriodExpr(expr)) return resolvePeriodRange(expr, config);
  const rolling = rollingShift(expr);
  if (rolling) {
    const now = requireNow(config);
    const moved = shiftByUnits(now, ...rolling, config.timeZone);
    return rolling[1] === -1 ? [moved, now] : [now, moved];
  }
  throw new Error('`within` requires a range expression (period or rolling), not an edge point');
};
