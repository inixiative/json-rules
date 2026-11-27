import { isValid } from 'date-fns';
import { isPlainObject } from 'lodash-es';
import { rangeExprRequired, UsageError } from './errors';
import { isOrderedValue } from './number';
import {
  type INTERVAL_FIELDS,
  leafCatalogEntry,
  PERIOD_CLOCK_UNITS,
  PERIOD_UNITS,
  RELATIVE_UNITS,
  type RelativeUnit,
  UPPER_BOUND_OPERATORS,
} from './operatorCatalog';
import type {
  DateConfig,
  DateExpr,
  DateInputValue,
  EdgeExpr,
  PeriodExpr,
  PeriodUnit,
  RelativeUnits,
  RollingExpr,
} from './types';

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

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export const utcDate = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date => {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, ms);
  return date;
};

const WALL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

const wallFormatter = (zone: string): Intl.DateTimeFormat => {
  let formatter = WALL_FORMATTERS.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    WALL_FORMATTERS.set(zone, formatter);
  }
  return formatter;
};

/** Wall-clock components of `instant` in `zone`, held in a UTC Date so host TZ never leaks. */
export const wallUtcOf = (instant: Date, zone: string): Date => {
  if (zone === DEFAULT_ZONE) return new Date(instant.getTime());
  const parts = wallFormatter(zone).formatToParts(instant);
  let era = 'AD';
  let year = 0;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  for (const part of parts) {
    switch (part.type) {
      case 'era':
        era = part.value;
        break;
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value);
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
    }
  }
  const isoYear = era === 'BC' || era === 'B' ? 1 - year : year;
  const ms = ((instant.getTime() % 1000) + 1000) % 1000;
  return utcDate(isoYear, month - 1, day, hour === 24 ? 0 : hour, minute, second, ms);
};

const zoneOffsetMs = (instantMs: number, zone: string): number =>
  wallUtcOf(new Date(instantMs), zone).getTime() - instantMs;

// Postgres AT TIME ZONE semantics: ambiguous fall-back times resolve to standard (later) time;
// nonexistent spring-forward times shift forward using the pre-gap offset.
export const fromWallUtc = (wall: Date, zone: string): Date => {
  if (zone === DEFAULT_ZONE) return new Date(wall.getTime());
  const wallMs = wall.getTime();
  const approx = wallMs - zoneOffsetMs(wallMs, zone);
  const oBefore = zoneOffsetMs(approx - 3 * HOUR_MS, zone);
  const oAfter = zoneOffsetMs(approx + 3 * HOUR_MS, zone);
  if (oBefore === oAfter) return new Date(wallMs - oBefore);

  const cBefore = wallMs - oBefore;
  const cAfter = wallMs - oAfter;
  const okBefore = wallUtcOf(new Date(cBefore), zone).getTime() === wallMs;
  const okAfter = wallUtcOf(new Date(cAfter), zone).getTime() === wallMs;
  if (okBefore && okAfter) return new Date(Math.max(cBefore, cAfter));
  if (okBefore) return new Date(cBefore);
  if (okAfter) return new Date(cAfter);
  return new Date(cBefore);
};

const ZONED_TIME = /\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/;
const hasExplicitZone = (value: string): boolean =>
  ZONED_TIME.test(value) || /\b(?:GMT|UTC)\b/.test(value);

const ISO_DATE_RE =
  /^([+-]?\d{4,6})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(?:\s*([zZ]|[+-]\d{2}(?::?\d{2})?))?$/;

const parseOffsetMs = (suffix: string): number => {
  if (suffix === 'Z' || suffix === 'z') return 0;
  const sign = suffix[0] === '-' ? -1 : 1;
  const digits = suffix.slice(1).replace(':', '');
  const hours = Number(digits.slice(0, 2));
  const minutes = digits.length >= 4 ? Number(digits.slice(2, 4)) : 0;
  return sign * (hours * 60 + minutes) * MINUTE_MS;
};

/**
 * Parse a comparison/field value into an instant, given the already-resolved anchor zone.
 * - Date object / epoch number → absolute instant, used as-is (never anchored).
 * - String with an explicit zone (`Z` or `±HH[:MM]` after a time) → absolute.
 * - Naive string (date-only or zoneless datetime) → anchored in `zone` (midnight for date-only).
 */
export const parseDateValue = (value: DateInputValue | undefined, zone: string): Date => {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string') return new Date(Number.NaN);
  const trimmed = value.trim();
  if (!trimmed) return new Date(Number.NaN);
  if (/^-?\d+$/.test(trimmed)) return new Date(Number(trimmed));

  const iso = ISO_DATE_RE.exec(trimmed);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const hour = iso[4] ? Number(iso[4]) : 0;
    const minute = iso[5] ? Number(iso[5]) : 0;
    const second = iso[6] ? Number(iso[6]) : 0;
    const ms = iso[7] ? Number(iso[7].slice(0, 3).padEnd(3, '0')) : 0;
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59)
      return new Date(Number.NaN);
    const maxDay = utcDate(year, month, 0).getUTCDate();
    if (day < 1 || day > maxDay) return new Date(Number.NaN);
    const wall = utcDate(year, month - 1, day, hour, minute, second, ms);
    if (iso[8]) return new Date(wall.getTime() - parseOffsetMs(iso[8]));
    return fromWallUtc(wall, zone);
  }

  if (hasExplicitZone(trimmed)) return new Date(trimmed);
  const parsed = new Date(trimmed);
  if (!isValid(parsed)) return parsed;
  const wall = utcDate(
    parsed.getFullYear(),
    parsed.getMonth(),
    parsed.getDate(),
    parsed.getHours(),
    parsed.getMinutes(),
    parsed.getSeconds(),
    parsed.getMilliseconds(),
  );
  return fromWallUtc(wall, zone);
};

const addWallMonths = (wall: Date, delta: number): Date => {
  const total = wall.getUTCFullYear() * 12 + wall.getUTCMonth() + delta;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const maxDay = utcDate(year, month + 1, 0).getUTCDate();
  return utcDate(
    year,
    month,
    Math.min(wall.getUTCDate(), maxDay),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    wall.getUTCMilliseconds(),
  );
};

export const requireNow = (config: ResolvedDateConfig): Date => {
  if (config.now === undefined)
    throw new UsageError('date expressions require `now` to be supplied to the evaluator');
  if (!isOrderedValue(config.now)) throw new UsageError(`invalid \`now\`: ${String(config.now)}`);
  const base = parseDateValue(config.now, config.timeZone);
  if (!isValid(base)) throw new UsageError(`invalid \`now\`: ${String(config.now)}`);
  return base;
};

// Units apply as Postgres applies an interval to a wall-clock time: the month part (years,
// quarters, months), then the day part (weeks, days), then time — so a shift lands on the same
// instant in check() and in toSql, at a month end (2024-02-29 + 1 year 1 month is 2025-03-29)
// and across a DST change in the evaluation's zone (a day is 23 hours on the spring-forward day).
/** The units' total in one Postgres interval field (months, days or secs). */
const intervalTotal = (
  units: RelativeUnits<number>,
  field: (typeof INTERVAL_FIELDS)[number],
): number =>
  (Object.entries(units) as [RelativeUnit, number][]).reduce(
    (total, [unit, amount]) =>
      Object.hasOwn(RELATIVE_UNITS, unit) && RELATIVE_UNITS[unit].interval === field
        ? total + amount * RELATIVE_UNITS[unit].factor
        : total,
    0,
  );

const shiftWall = (wall: Date, units: RelativeUnits<number>, direction: 1 | -1): Date => {
  const months = intervalTotal(units, 'months');
  const days = intervalTotal(units, 'days');
  const seconds = intervalTotal(units, 'secs');
  let shifted = wall;
  if (months) shifted = addWallMonths(shifted, direction * months);
  if (days) shifted = new Date(shifted.getTime() + direction * days * DAY_MS);
  if (seconds) shifted = new Date(shifted.getTime() + direction * seconds * 1000);
  return shifted;
};

/** Move `base` by `units` on the wall clock of `zone` — forward for `ahead` (1), back for `ago` (-1). */
export const shiftByUnits = (
  base: Date,
  units: RelativeUnits<number>,
  direction: 1 | -1,
  zone: string,
): Date => fromWallUtc(shiftWall(wallUtcOf(base, zone), units, direction), zone);

const isRollingExpr = <A>(e: DateExpr<A>): e is RollingExpr<A> => 'ago' in e || 'ahead' in e;
/** A rolling expression from units and a direction: back (-1) is `ago`, forward (1) `ahead`. */
export const rollingExpr = <A>(units: RelativeUnits<A>, direction: 1 | -1): RollingExpr<A> =>
  direction === -1 ? { ago: units } : { ahead: units };

/** A rolling expression's units and direction: `ago` moves back (-1), `ahead` forward (1). */
export const rollingShift = <A>(expr: DateExpr<A>): [RelativeUnits<A>, 1 | -1] | null =>
  isRollingExpr(expr) ? ('ago' in expr ? [expr.ago, -1] : [expr.ahead, 1]) : null;

export const isPeriodExpr = <A>(e: DateExpr<A>): e is PeriodExpr =>
  'this' in e || 'last' in e || 'next' in e;
export const isEdgeExpr = <A>(e: DateExpr<A>): e is EdgeExpr => 'start' in e || 'end' in e;

/** What a period expression names, whichever of this / last / next it uses. */
export const namedPeriod = (expr: PeriodExpr): unknown =>
  'this' in expr ? expr.this : 'last' in expr ? expr.last : expr.next;

/** The period an edge expression (`{ start }` / `{ end }`) wraps. */
export const edgePeriod = (expr: EdgeExpr): PeriodExpr => ('start' in expr ? expr.start : expr.end);

const periodUnit = (expr: PeriodExpr): PeriodUnit => {
  const unit = namedPeriod(expr);
  if (typeof unit !== 'string' || !PERIOD_UNITS.includes(unit))
    throw new Error(`Unknown period unit '${String(unit)}'`);
  return unit as PeriodUnit;
};

const wallPeriodBounds = (
  wall: Date,
  unit: PeriodUnit,
  config: ResolvedDateConfig,
): [Date, Date] => {
  const y = wall.getUTCFullYear();
  const m = wall.getUTCMonth();
  const d = wall.getUTCDate();
  const h = wall.getUTCHours();
  const min = wall.getUTCMinutes();
  const s = wall.getUTCSeconds();

  switch (unit) {
    case 'year':
      return [utcDate(y, 0, 1, 0, 0, 0, 0), utcDate(y, 11, 31, 23, 59, 59, 999)];
    case 'quarter': {
      const qStart = Math.floor(m / 3) * 3;
      return [utcDate(y, qStart, 1, 0, 0, 0, 0), utcDate(y, qStart + 3, 0, 23, 59, 59, 999)];
    }
    case 'month':
      return [utcDate(y, m, 1, 0, 0, 0, 0), utcDate(y, m + 1, 0, 23, 59, 59, 999)];
    case 'week':
    case 'isoWeek': {
      const mondayStart = unit === 'isoWeek' || config.weekStart !== 'sunday';
      const dow = wall.getUTCDay();
      const offset = mondayStart ? (dow + 6) % 7 : dow;
      return [
        utcDate(y, m, d - offset, 0, 0, 0, 0),
        utcDate(y, m, d - offset + 6, 23, 59, 59, 999),
      ];
    }
    case 'day':
      return [utcDate(y, m, d, 0, 0, 0, 0), utcDate(y, m, d, 23, 59, 59, 999)];
    case 'hour':
      return [utcDate(y, m, d, h, 0, 0, 0), utcDate(y, m, d, h, 59, 59, 999)];
    case 'minute':
      return [utcDate(y, m, d, h, min, 0, 0), utcDate(y, m, d, h, min, 59, 999)];
    case 'second':
      return [utcDate(y, m, d, h, min, s, 0), utcDate(y, m, d, h, min, s, 999)];
  }
};

/** Resolve a calendar period (this/last/next) to its [start, end] boundaries. */
const resolvePeriodRange = (expr: PeriodExpr, config: ResolvedDateConfig): [Date, Date] => {
  const unit = periodUnit(expr);
  const step = 'last' in expr ? -1 : 'next' in expr ? 1 : 0;
  const now = requireNow(config);
  const nowWall = wallUtcOf(now, config.timeZone);

  // Sub-day periods keep `now`'s exact offset so `{ this: 'hour' }` always contains `now`
  // during a repeated fall-back hour.
  if (unit === 'hour' || unit === 'minute' || unit === 'second') {
    const unitMs = unit === 'hour' ? HOUR_MS : unit === 'minute' ? MINUTE_MS : 1000;
    const within =
      (unit === 'hour' ? nowWall.getUTCMinutes() * MINUTE_MS : 0) +
      (unit !== 'second' ? nowWall.getUTCSeconds() * 1000 : 0) +
      nowWall.getUTCMilliseconds();
    const startMs = now.getTime() - within + step * unitMs;
    return [new Date(startMs), new Date(startMs + unitMs - 1)];
  }

  // Step whole periods first, then snap — robust to month-length clamping.
  const relativeKey = `${PERIOD_CLOCK_UNITS[unit]}s` as RelativeUnit;
  const stepped = step === 0 ? nowWall : shiftWall(nowWall, { [relativeKey]: 1 }, step);
  const [startWall, endWall] = wallPeriodBounds(stepped, unit, config);
  return [fromWallUtc(startWall, config.timeZone), fromWallUtc(endWall, config.timeZone)];
};

/**
 * Resolve any date expression to a single instant (for value expressions):
 * Rolling → the offset instant; edge → its boundary; bare period → its start boundary.
 */
export const resolveDateExprInstant = (expr: DateExpr<number>, config: ResolvedDateConfig): Date =>
  isPeriodExpr(expr) ? resolvePeriodRange(expr, config)[0] : resolveDateExpr(expr, config);

/**
 * Resolve a point expression (for before/after/onOrBefore/onOrAfter).
 * Rolling → the offset instant; edge → the named boundary of a period.
 */
export const resolveDateExpr = (expr: DateExpr<number>, config: ResolvedDateConfig): Date => {
  const rolling = rollingShift(expr);
  if (rolling) return shiftByUnits(requireNow(config), ...rolling, config.timeZone);
  if (isEdgeExpr(expr)) {
    const [start, end] = resolvePeriodRange(edgePeriod(expr) as PeriodExpr, config);
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
): Date => {
  if (isPeriodExpr(expr)) {
    const [start, end] = resolvePeriodRange(expr, config);
    // An upper bound anchors at the start; a negation at its positive form's edge.
    const positive = leafCatalogEntry({ dateOperator: operator })?.negates ?? operator;
    return UPPER_BOUND_OPERATORS.includes(positive) ? start : end;
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
): [Date, Date] => {
  if (isPeriodExpr(expr)) return resolvePeriodRange(expr, config);
  const rolling = rollingShift(expr);
  if (rolling) {
    const now = requireNow(config);
    const moved = shiftByUnits(now, ...rolling, config.timeZone);
    return rolling[1] === -1 ? [moved, now] : [now, moved];
  }
  throw rangeExprRequired('within');
};
