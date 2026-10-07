import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';
import { resolveExpr, resolveUnits } from './amount';
import {
  DEFAULT_ZONE,
  isDateExpr,
  type ResolvedDateConfig,
  resolveDateExpr,
  resolveDateExprRange,
  resolvePointForOperator,
  shiftByUnits,
} from './dateExpr';
import { isOrderedValue, orderPair } from './number';
import { offsetShift } from './offset';
import { DateOperator } from './operator';
import { DAY_NAMES, NEGATED_OPERATORS, WINDOW_OPERATORS } from './operatorCatalog';
import { parseScopeRef, readField, type Scopes } from './scope';
import type { DateConfig, DateExpr, DateInputValue, DateRule, RuleValue } from './types';
import { type ReadSource, readValueSource, rowRef } from './valueSource';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export const checkDate = (
  condition: DateRule,
  scopes: Scopes,
  context: unknown,
  config: DateConfig = {},
  bindings?: Record<string, RuleValue>,
): boolean | string => {
  const fieldValue = readField(condition.field, scopes);

  // Read the zone ONCE. Left unset when the caller set none, so expression `now` keeps its
  // prior behavior; anchoring and shifts default to UTC.
  const exprConfig = resolveDateConfig(config, (source) =>
    readValueSource(source, scopes, context, bindings),
  );
  const tz = exprConfig.timeZone;

  // Null: non-match for positive operators, match for negated ones (2.19.0 negation
  // ruling) — the compilers carry the same split. `== null`, not falsy: epoch 0 is a
  // real instant and compares; '' falls to the validity error below.
  if (fieldValue == null) {
    if (NEGATED_OPERATORS.includes(condition.dateOperator)) return true;
    return condition.error || `${condition.field} has no value`;
  }
  if (!isOrderedValue(fieldValue))
    throw new Error(`${condition.field} is not a valid date: ${String(fieldValue)}`);

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

    case DateOperator.dayIn:
    case DateOperator.dayNotIn: {
      const days = dayNumbers(readValueSource(condition, scopes, context, bindings));
      if (days === null) return condition.error || `${condition.field} has no comparison value`;
      const listed = days.includes(fieldDate.tz(tz).day());
      const names = days.map((day) => DAY_NAMES[day]).join(' or ');
      return condition.dateOperator === DateOperator.dayIn
        ? listed || getError(`must be on ${names}`)
        : !listed || getError(`must not be on ${names}`);
    }

    default:
      throw new Error('Unknown date operator');
  }
};

const parseCompareDates = (
  condition: DateRule,
  scopes: Scopes,
  context: unknown,
  config: ResolvedDateConfig,
  tz: string,
  bindings?: Record<string, RuleValue>,
): [dayjs.Dayjs, dayjs.Dayjs | undefined] | null => {
  const operator = condition.dateOperator;
  if (operator === DateOperator.dayIn || operator === DateOperator.dayNotIn)
    return [dayjs(), undefined]; // Won't be used for dayIn/dayNotIn

  const read: ReadSource = (source) => readValueSource(source, scopes, context, bindings);
  const raw = readValueSource(condition, scopes, context, bindings);
  if (raw === null || raw === undefined) return null;
  const move = condition.offset === undefined ? undefined : offsetShift(read(condition.offset));
  if (move === null) return null;
  const shift = (point: dayjs.Dayjs): dayjs.Dayjs | null => {
    if (move === undefined) return point;
    const units = resolveUnits(move[0], read);
    return units && shiftByUnits(point, units, move[1], tz);
  };

  if (WINDOW_OPERATORS.includes(operator)) {
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
    const [start, end] = orderPair([date1, date2]);
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
 * The evaluation's date config with its zone read — the single seam that decides which zone
 * anchors a NAIVE (zoneless) value, frames dayIn/dayNotIn and runs shifts, for ONE evaluation.
 * A zone is a string or a value source read from context or bindings; one that reads nothing
 * is UTC. It is one zone per evaluation, so a row (`$.`) path has no meaning here. Absolute
 * instants never consult it.
 */
export const resolveDateConfig = (config: DateConfig, read: ReadSource): ResolvedDateConfig => {
  const zone = config.timeZone;
  if (zone === undefined || typeof zone === 'string')
    return { ...config, timeZone: zone ?? DEFAULT_ZONE };
  if (rowRef(zone))
    throw new Error(`timeZone is one per evaluation; read it from context, not '${zone.path}'`);
  const read_ = read(zone);
  if (read_ !== null && read_ !== undefined && typeof read_ !== 'string')
    throw new Error(`timeZone reads a zone name (got ${String(read_)})`);
  return { ...config, timeZone: read_ ?? DEFAULT_ZONE };
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

// Literal and context date values compile to concrete Dates through the same parse-and-anchor
// seam check() uses (naive strings → midnight in the zone; instants as-is): a raw 'YYYY-MM-DD'
// is rejected by Prisma and would carry different zone semantics than check().
export const coerceDateLiteral = (value: unknown, zone: string): Date => {
  const parsed = isOrderedValue(value) ? parseDateValue(value, zone) : dayjs(Number.NaN);
  if (!parsed.isValid()) throw new Error(`Invalid date value: ${String(value)}`);
  return parsed.toDate();
};

/** A weekday list as `EXTRACT(DOW)` numbers (sunday 0); null when it reads nothing. */
export const dayNumbers = (days: unknown): number[] | null => {
  if (days === null || days === undefined) return null;
  if (!Array.isArray(days)) throw new Error('a weekday operator requires an array of day names');
  return days.map((day) => {
    const index = (DAY_NAMES as readonly string[]).indexOf(String(day).toLowerCase());
    if (index === -1) throw new Error(`Unknown day name: ${String(day)}`);
    return index;
  });
};
