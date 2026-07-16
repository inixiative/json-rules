import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { get } from 'lodash-es';
import {
  isDateExpr,
  isPeriodExpr,
  resolveDateExpr,
  resolveDateExprRange,
  resolvePeriodRange,
} from './dateExpr';
import { DateOperator } from './operator';
import type { DateConfig, DateInputValue, DateRule, RuleValue } from './types';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export const checkDate = <TData extends Record<string, unknown>>(
  condition: DateRule,
  data: TData,
  context: TData,
  config: DateConfig = {},
  bindings?: Record<string, RuleValue>,
): boolean | string => {
  const fieldValue = get(data, condition.field) as unknown;

  if (!fieldValue) throw new Error(`${condition.field} is null or undefined`);
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

  const dates = parseCompareDates(condition, data, context, exprConfig, tz);
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

const parseCompareDates = <TData extends Record<string, unknown>>(
  condition: DateRule,
  data: TData,
  context: TData,
  config: DateConfig,
  tz: string,
): [dayjs.Dayjs, dayjs.Dayjs | undefined] => {
  if (condition.dateOperator === DateOperator.within) {
    if (!isDateExpr(condition.value))
      throw new Error('within operator requires a range date expression');
    return resolveDateExprRange(condition.value, config);
  }

  const requiresTwoDates: DateOperator[] = [DateOperator.between, DateOperator.notBetween];

  if (requiresTwoDates.includes(condition.dateOperator)) {
    if (!Array.isArray(condition.value) || condition.value.length !== 2)
      throw new Error(`${condition.dateOperator} operator requires an array of two dates`);
    const [rawDate1, rawDate2] = condition.value as [unknown, unknown];
    const date1 = isDateExpr(rawDate1)
      ? resolveDateExpr(rawDate1, config)
      : parseDateValue(rawDate1 as DateInputValue, tz);
    const date2 = isDateExpr(rawDate2)
      ? resolveDateExpr(rawDate2, config)
      : parseDateValue(rawDate2 as DateInputValue, tz);
    if (!date1.isValid()) throw new Error(`Invalid start date: ${condition.value[0]}`);
    if (!date2.isValid()) throw new Error(`Invalid end date: ${condition.value[1]}`);
    // Auto-sort: ensure startDate <= endDate
    const [startDate, endDate] =
      date1.isBefore(date2) || date1.isSame(date2) ? [date1, date2] : [date2, date1];
    return [startDate, endDate];
  }

  const requiresOneDate: DateOperator[] = [
    DateOperator.before,
    DateOperator.after,
    DateOperator.onOrBefore,
    DateOperator.onOrAfter,
  ];

  if (requiresOneDate.includes(condition.dateOperator)) {
    let value: DateInputValue | undefined;
    if (condition.value !== undefined) {
      if (isDateExpr(condition.value)) {
        // Bare period + before/after ⇒ implied edge (before→start, after→end).
        if (isPeriodExpr(condition.value)) {
          const [start, end] = resolvePeriodRange(condition.value, config);
          const useStart =
            condition.dateOperator === DateOperator.before ||
            condition.dateOperator === DateOperator.onOrBefore;
          return [useStart ? start : end, undefined];
        }
        return [resolveDateExpr(condition.value, config), undefined];
      }
      if (Array.isArray(condition.value)) {
        throw new Error(`${condition.dateOperator} operator requires a single date value`);
      }
      value = condition.value as DateInputValue;
    } else if (condition.path) {
      // Support $.path for current element
      if (condition.path.startsWith('$.')) {
        const pathValue = get(data, condition.path.substring(2)) as unknown;
        value = isDateInputValue(pathValue) ? pathValue : undefined;
      } else {
        const pathValue = get(context, condition.path) as unknown;
        value = isDateInputValue(pathValue) ? pathValue : undefined;
      }
    } else {
      throw new Error('No value or path specified for date comparison');
    }
    const date = parseDateValue(value, tz);
    if (!date.isValid()) throw new Error(`Invalid comparison date: ${value}`);
    return [date, undefined];
  }

  return [dayjs(), undefined]; // Won't be used for dayIn/dayNotIn
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
