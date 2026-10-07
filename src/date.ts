import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import {
  isDateExpr,
  resolveDateExpr,
  resolveDateExprRange,
  resolvePointForOperator,
  shiftByUnits,
} from './dateExpr';
import { DateOperator } from './operator';
import { readField, readPath, type Scopes } from './scope';
import type { DateConfig, DateExpr, DateInputValue, DateRule, RuleValue } from './types';
import {
  offsetShift,
  type ReadRef,
  readValueSource,
  resolveExpr,
  resolveUnits,
} from './valueSource';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

const NEGATED_DATE_OPERATORS: readonly DateOperator[] = [
  DateOperator.notBefore,
  DateOperator.notAfter,
  DateOperator.notWithin,
  DateOperator.notBetween,
  DateOperator.dayNotIn,
];

// `within` and its complement take a RANGE expression (period or rolling window), never a
// point or a literal pair — the one date shape the compilers resolve to two bounds.
export const RANGE_DATE_OPERATORS: readonly DateOperator[] = [
  DateOperator.within,
  DateOperator.notWithin,
];
export const isRangeOperator = (operator: string): boolean =>
  (RANGE_DATE_OPERATORS as readonly string[]).includes(operator);

export const checkDate = (
  condition: DateRule,
  scopes: Scopes,
  context: unknown,
  config: DateConfig = {},
  bindings?: Record<string, RuleValue>,
): boolean | string => {
  const fieldValue = readField(condition.field, scopes);

  // Null: non-match for positive operators, match for negated ones (2.19.0 negation
  // ruling) — the compilers carry the same split. `== null`, not falsy: epoch 0 is a
  // real instant and compares; '' falls to the validity error below.
  if (fieldValue == null) {
    if (NEGATED_DATE_OPERATORS.includes(condition.dateOperator)) return true;
    return condition.error || `${condition.field} has no value`;
  }
  if (!isDateInputValue(fieldValue))
    throw new Error(`${condition.field} is not a valid date: ${String(fieldValue)}`);

  // Resolve the anchoring zone ONCE (bind → literal → UTC) and normalize the config the
  // date-expression layer sees: honor a resolved zone when the caller set one, but leave
  // it unset otherwise so expression `now` resolution keeps its prior behavior.
  const tz = resolveTimeZone(config, bindings);
  const exprConfig: DateConfig =
    config.timeZone !== undefined ? { ...config, timeZone: tz } : config;

  // A naive field string is anchored in the resolved zone (default UTC); an absolute
  // instant (Date/number/zone-stamped string) is used as-is. Consistent with the
  // engine's config.timeZone policy used by dateExpr and both compilers.
  const fieldDate = parseDateValue(fieldValue, tz);

  if (!fieldDate.isValid())
    throw new Error(`${condition.field} is not a valid date: ${fieldValue}`);

  const getError = (op: string) => condition.error || `${condition.field} ${op}`;

  const dates = parseCompareDates(condition, scopes, context, exprConfig, tz, bindings);
  // Nothing to compare against — a null path, bind or magnitude: no operator matches, as SQL's
  // comparison with NULL never does. A null field was already decided above.
  if (dates === null) return condition.error || `${condition.field} has no comparison value`;
  const compareDate = dates[0];
  const endDate = dates[1];

  switch (condition.dateOperator) {
    case DateOperator.before:
      return fieldDate.isBefore(compareDate) || getError(`must be before ${compareDate.format()}`);

    case DateOperator.after:
      return fieldDate.isAfter(compareDate) || getError(`must be after ${compareDate.format()}`);

    case DateOperator.onOrBefore:
      return (
        fieldDate.isSameOrBefore(compareDate) ||
        getError(`must be on or before ${compareDate.format()}`)
      );

    case DateOperator.onOrAfter:
      return (
        fieldDate.isSameOrAfter(compareDate) ||
        getError(`must be on or after ${compareDate.format()}`)
      );

    case DateOperator.within: {
      if (!endDate) throw new Error('within operator requires a range');
      return (
        (fieldDate.isSameOrAfter(compareDate) && fieldDate.isSameOrBefore(endDate)) ||
        getError(`must be within ${compareDate.format()} and ${endDate.format()}`)
      );
    }

    case DateOperator.notBefore:
      return (
        fieldDate.isSameOrAfter(compareDate) ||
        getError(`must not be before ${compareDate.format()}`)
      );

    case DateOperator.notAfter:
      return (
        fieldDate.isSameOrBefore(compareDate) ||
        getError(`must not be after ${compareDate.format()}`)
      );

    case DateOperator.notWithin: {
      if (!endDate) throw new Error('notWithin operator requires a range');
      return (
        fieldDate.isBefore(compareDate) ||
        fieldDate.isAfter(endDate) ||
        getError(`must not be within ${compareDate.format()} and ${endDate.format()}`)
      );
    }

    case DateOperator.between: {
      if (!endDate) throw new Error('between operator requires an end date');
      return (
        (fieldDate.isSameOrAfter(compareDate) && fieldDate.isSameOrBefore(endDate)) ||
        getError(`must be between ${compareDate.format()} and ${endDate?.format()}`)
      );
    }

    case DateOperator.notBetween: {
      if (!endDate) throw new Error('notBetween operator requires an end date');
      return (
        fieldDate.isBefore(compareDate) ||
        fieldDate.isAfter(endDate) ||
        getError(`must not be between ${compareDate.format()} and ${endDate?.format()}`)
      );
    }

    case DateOperator.dayIn: {
      if (!Array.isArray(condition.value))
        throw new Error('dayIn operator requires an array of day names');
      const dayName = fieldDate.tz(tz).format('dddd').toLowerCase();
      const allowedDays = condition.value.map((day) => String(day).toLowerCase());
      return allowedDays.includes(dayName) || getError(`must be on ${allowedDays.join(' or ')}`);
    }

    case DateOperator.dayNotIn: {
      if (!Array.isArray(condition.value))
        throw new Error('dayNotIn operator requires an array of day names');
      const day = fieldDate.tz(tz).format('dddd').toLowerCase();
      const excludedDays = condition.value.map((excludedDay) => String(excludedDay).toLowerCase());
      return !excludedDays.includes(day) || getError(`must not be on ${excludedDays.join(' or ')}`);
    }

    default:
      throw new Error('Unknown date operator');
  }
};

const parseCompareDates = (
  condition: DateRule,
  scopes: Scopes,
  context: unknown,
  config: DateConfig,
  tz: string,
  bindings?: Record<string, RuleValue>,
): [dayjs.Dayjs, dayjs.Dayjs | undefined] | null => {
  const operator = condition.dateOperator;
  if (operator === DateOperator.dayIn || operator === DateOperator.dayNotIn)
    return [dayjs(), undefined]; // Won't be used for dayIn/dayNotIn

  const read: ReadRef = (ref) => readPath(ref, scopes, context);
  const raw = readValueSource(condition, scopes, context, bindings);
  if (raw === null || raw === undefined) return null;
  const move =
    condition.offset === undefined
      ? undefined
      : offsetShift(readValueSource(condition.offset, scopes, context, bindings));
  if (move === null) return null;
  const shift = (point: dayjs.Dayjs): dayjs.Dayjs | null => {
    if (move === undefined) return point;
    const units = resolveUnits(move[0], read);
    return units && shiftByUnits(point, units, move[1], tz);
  };

  if (isRangeOperator(operator)) {
    if (!isDateExpr(raw)) throw new Error(`${operator} operator requires a range date expression`);
    const expr = resolveExpr(raw, read);
    return expr && resolveDateExprRange(expr, config);
  }

  const toPoint = (value: unknown, label: string): dayjs.Dayjs | null => {
    if (value === null || value === undefined) return null;
    if (isDateExpr(value)) {
      const expr = resolveExpr(value, read);
      return expr && resolveDateExpr(expr, config);
    }
    const date = parseDateValue(value as DateInputValue, tz);
    if (!date.isValid()) throw new Error(`Invalid ${label}: ${String(value)}`);
    return date;
  };

  if (operator === DateOperator.between || operator === DateOperator.notBetween) {
    if (!Array.isArray(raw) || raw.length !== 2)
      throw new Error(`${operator} operator requires an array of two dates`);
    const date1 = toPoint(raw[0], 'start date');
    const date2 = toPoint(raw[1], 'end date');
    if (!date1 || !date2) return null;
    // Auto-sort: ensure startDate <= endDate
    const [start, end] = date1.isAfter(date2) ? [date2, date1] : [date1, date2];
    const shiftedStart = shift(start);
    const shiftedEnd = shift(end);
    return shiftedStart && shiftedEnd ? [shiftedStart, shiftedEnd] : null;
  }

  if (Array.isArray(raw)) throw new Error(`${operator} operator requires a single date value`);
  // Bare period + before/after ⇒ implied edge (before→start, after→end); the one anchoring
  // rule all three rails share.
  const pointOf = (expr: DateExpr): dayjs.Dayjs | null => {
    const resolved = resolveExpr(expr, read);
    return resolved && resolvePointForOperator(resolved, operator, config);
  };
  const point = isDateExpr(raw) ? pointOf(raw) : toPoint(raw, 'comparison date');
  if (!point) return null;
  const shifted = shift(point);
  return shifted && [shifted, undefined];
};

/**
 * The single seam that decides which timezone anchors a NAIVE (zoneless) value and frames
 * the dayIn/dayNotIn weekday, for ONE evaluation. Precedence: a zone bound from the
 * evaluation's `bindings` → a literal `config.timeZone` → 'UTC'. A future extension can
 * source a per-record zone here (see docs/TIMEZONE.md) without touching call sites.
 * Absolute instants never reach this seam — they bypass anchoring entirely.
 */
export const resolveTimeZone = (
  config: DateConfig,
  bindings?: Record<string, RuleValue>,
): string => {
  const zone = config.timeZone;
  if (zone && typeof zone === 'object' && 'bind' in zone) {
    const bound = bindings?.[zone.bind];
    return typeof bound === 'string' ? bound : 'UTC';
  }
  return zone ?? 'UTC';
};

// Detects an explicit zone on a date STRING only (never String(Date), whose render is
// host-locale-dependent): a trailing `Z`, or a `±HH:MM`/`±HHMM` offset after the time.
const TRAILING_OFFSET = /[+-]\d{2}:?\d{2}$/;
const hasExplicitZone = (value: string): boolean =>
  /Z$/.test(value) || (value.includes('T') && TRAILING_OFFSET.test(value));

/**
 * Parse a comparison/field value into an instant, given the already-resolved anchor zone.
 * - Date object / epoch number → absolute instant, used as-is (never anchored).
 * - String with an explicit zone (`Z` or `±HH:MM` after a time) → absolute.
 * - Naive string (date-only or zoneless datetime) → anchored in `tz` via dayjs.tz; a
 *   date-only string becomes midnight in that zone.
 */
export const parseDateValue = (value: DateInputValue | undefined, tz: string): dayjs.Dayjs => {
  if (typeof value === 'string' && !hasExplicitZone(value)) {
    // dayjs.tz throws on an unparseable string; return the (invalid) base parse instead
    // so callers' isValid() checks surface the friendly "not a valid date" error.
    const base = dayjs(value);
    if (!base.isValid()) return base;
    return dayjs.tz(value, tz);
  }
  return dayjs(value);
};

export const isDateInputValue = (value: unknown): value is DateInputValue =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;
