import { tz } from '@date-fns/tz';
import { format as formatDateFns, isValid } from 'date-fns';
import { resolveExpr } from './amount';
import type { EvalOptions } from './check';
import { clockFloorError } from './clock';
import {
  DEFAULT_ZONE,
  isDateExpr,
  parseDateValue,
  type ResolvedDateConfig,
  resolveDateExpr,
  resolveDateExprRange,
  resolvePointForOperator,
  wallUtcOf,
} from './dateExpr';
import { rangeExprRequired, UsageError, unknownOperator } from './errors';
import { isOrderedValue, orderPair, readPair } from './number';
import { applyDateOffset, offsetShift } from './offset';
import { DateOperator } from './operator';
import {
  DATE_RANGE_OPERATORS,
  DAY_LIST_OPERATORS,
  DAY_NAMES,
  type FieldKind,
  NEGATED_OPERATORS,
  WINDOW_OPERATORS,
} from './operatorCatalog';
import { readField, type Scopes } from './scope';
import type { DateConfig, DateExpr, DateInputValue, DateRule, RuleValue } from './types';
import { type ValidationResult, validationResult } from './validate';
import { type ReadSource, readValueSource, rowRef } from './valueSource';

export { parseDateValue };

export type FormatDateOptions = {
  /** A date-fns format string (e.g. `'MMM d, h:mm a zzz'`). Defaults to ISO 8601 (`"yyyy-MM-dd'T'HH:mm:ssXXX"`). */
  format?: string;
  /** An IANA time zone id (e.g. `'America/New_York'`). Defaults to UTC. */
  timeZone?: string;
};

const ISO_DATE_FORMAT = "yyyy-MM-dd'T'HH:mm:ssXXX";

const zoneNameAt = (date: Date, zone: string, style: 'short' | 'long'): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value ?? zone;

// date-fns v4 prints GMT±H for `z..zzzz`; substitute unescaped `z{1,4}` with IANA zone names
// while leaving quoted literals and invalid `z{5,}` runs untouched for date-fns validation.
const expandZoneTokens = (format: string, date: Date, zone: string): string => {
  if (!format.includes('z')) return format;
  let out = '';
  let inQuote = false;
  let i = 0;
  while (i < format.length) {
    const ch = format[i];
    if (ch === "'") {
      out += ch;
      if (inQuote && format[i + 1] === "'") {
        out += "'";
        i += 2;
        continue;
      }
      inQuote = !inQuote;
      i += 1;
      continue;
    }
    if (!inQuote && ch === 'z') {
      let end = i;
      while (end < format.length && format[end] === 'z') end += 1;
      const run = end - i;
      if (run <= 4) {
        const name = zoneNameAt(date, zone, run === 4 ? 'long' : 'short');
        out += `'${name.replace(/'/g, "''")}'`;
      } else {
        out += format.slice(i, end);
      }
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};

/**
 * Format a date (Date, ISO string, naive date string anchored in `timeZone`, or epoch ms) in an
 * IANA time zone using date-fns. Defaults to UTC and ISO 8601 (`"yyyy-MM-dd'T'HH:mm:ssXXX"`).
 * Throws `UsageError` on an invalid date, time zone, or format string.
 */
export const formatDate = (value: DateInputValue, options: FormatDateOptions = {}): string => {
  const zone = knownZone(options.timeZone ?? DEFAULT_ZONE);
  const date = parseDateValue(value, zone);
  if (!isValid(date)) throw new UsageError(`invalid date value: ${String(value)}`);
  const format = options.format ?? ISO_DATE_FORMAT;
  if (typeof format !== 'string' || format.length === 0)
    throw new UsageError('Date format must be a non-empty string');
  try {
    return formatDateFns(date, expandZoneTokens(format, date, zone), { in: tz(zone) });
  } catch (error) {
    if (error instanceof RangeError)
      throw new UsageError(`invalid date format '${format}': ${error.message}`);
    throw error;
  }
};

/** Check whether a date-fns format string is accepted by `formatDate`. */
export const validateDateFormat = (format: unknown): ValidationResult => {
  try {
    formatDate(0, { format: format as string });
    return validationResult([]);
  } catch (error) {
    if (error instanceof UsageError)
      return validationResult([{ path: '$', code: 'invalid_date_format', message: error.message }]);
    throw error;
  }
};

export const checkDate = (
  condition: DateRule,
  scopes: Scopes,
  config: DateConfig = {},
  bindings?: Record<string, RuleValue>,
): boolean | string => {
  const fieldValue = readField(condition.field, scopes);

  // Read the zone ONCE. Left unset when the caller set none, so expression `now` keeps its
  // prior behavior; anchoring and shifts default to UTC.
  const exprConfig = resolveDateConfig(config, (source) =>
    readValueSource(source, scopes, bindings),
  );
  const zone = exprConfig.timeZone;

  // Null: non-match for positive operators, match for negated ones (2.19.0 negation
  // ruling) — the compilers carry the same split. `== null`, not falsy: epoch 0 is a
  // real instant and compares; '' falls to the validity error below.
  if (fieldValue == null) {
    if (NEGATED_OPERATORS.includes(condition.dateOperator)) return true;
    return condition.error || `${condition.field} has no value`;
  }
  // A naive field string is anchored in the resolved zone (default UTC); an absolute
  // instant (Date/number/zone-stamped string) is used as-is. Consistent with the
  // engine's config.timeZone policy used by dateExpr and both compilers.
  const fieldDate = isOrderedValue(fieldValue) ? parseDateValue(fieldValue, zone) : null;
  if (!fieldDate || !isValid(fieldDate))
    throw new Error(`${condition.field} is not a valid date: ${String(fieldValue)}`);

  const getError = (op: string) => condition.error || `${condition.field} ${op}`;

  // A weekday list reads no instant.
  if (DAY_LIST_OPERATORS.includes(condition.dateOperator)) {
    const days = dayNumbers(readValueSource(condition, scopes, bindings));
    if (days === null) return condition.error || `${condition.field} has no comparison value`;
    const listed = days.includes(wallUtcOf(fieldDate, zone).getUTCDay());
    const names = days.map((day) => DAY_NAMES[day]).join(' or ');
    return condition.dateOperator === DateOperator.dayIn
      ? listed || getError(`must be on ${names}`)
      : !listed || getError(`must not be on ${names}`);
  }

  const dates = parseCompareDates(condition, scopes, exprConfig, zone, bindings);
  // Nothing to compare against — a null path, bind or magnitude: no operator matches, as SQL's
  // comparison with NULL never does. A null field was already decided above.
  if (dates === null) return condition.error || `${condition.field} has no comparison value`;
  // A window or range operator always reads a pair; the others read one point.
  const [compareDate, endDate = compareDate] = dates;
  const fieldMs = fieldDate.getTime();
  const compareMs = compareDate.getTime();
  const endMs = endDate.getTime();
  const show = (date: Date) => formatDate(date, { timeZone: zone });

  switch (condition.dateOperator) {
    case DateOperator.before:
      return fieldMs < compareMs || getError(`must be before ${show(compareDate)}`);

    case DateOperator.after:
      return fieldMs > compareMs || getError(`must be after ${show(compareDate)}`);

    case DateOperator.onOrBefore:
      return fieldMs <= compareMs || getError(`must be on or before ${show(compareDate)}`);

    case DateOperator.onOrAfter:
      return fieldMs >= compareMs || getError(`must be on or after ${show(compareDate)}`);

    case DateOperator.within:
      return (
        (fieldMs >= compareMs && fieldMs <= endMs) ||
        getError(`must be within ${show(compareDate)} and ${show(endDate)}`)
      );

    case DateOperator.notBefore:
      return fieldMs >= compareMs || getError(`must not be before ${show(compareDate)}`);

    case DateOperator.notAfter:
      return fieldMs <= compareMs || getError(`must not be after ${show(compareDate)}`);

    case DateOperator.notWithin:
      return (
        fieldMs < compareMs ||
        fieldMs > endMs ||
        getError(`must not be within ${show(compareDate)} and ${show(endDate)}`)
      );

    case DateOperator.between:
      return (
        (fieldMs >= compareMs && fieldMs <= endMs) ||
        getError(`must be between ${show(compareDate)} and ${show(endDate)}`)
      );

    case DateOperator.notBetween:
      return (
        fieldMs < compareMs ||
        fieldMs > endMs ||
        getError(`must not be between ${show(compareDate)} and ${show(endDate)}`)
      );

    default:
      throw unknownOperator((condition as { dateOperator?: unknown }).dateOperator, 'date');
  }
};

const parseCompareDates = (
  condition: DateRule,
  scopes: Scopes,
  config: ResolvedDateConfig,
  zone: string,
  bindings?: Record<string, RuleValue>,
): [Date] | [Date, Date] | null => {
  const operator = condition.dateOperator;

  const read: ReadSource = (source) => readValueSource(source, scopes, bindings);
  const raw = readValueSource(condition, scopes, bindings);
  if (raw === null || raw === undefined) return null;
  const offset = condition.offset === undefined ? undefined : read(condition.offset);
  const clockError = clockFloorError(raw, offset);
  if (clockError) throw clockError;
  if (condition.offset !== undefined && offsetShift(offset) === null) return null;
  const shift = (point: Date): Date | null =>
    condition.offset === undefined ? point : applyDateOffset(point, offset, read, zone);

  if (WINDOW_OPERATORS.includes(operator)) {
    if (!isDateExpr(raw)) throw rangeExprRequired(operator);
    const expr = resolveExpr(raw, read);
    return expr && resolveDateExprRange(expr, config);
  }

  const toPoint = (value: unknown, label: string): Date | null => {
    if (value === null || value === undefined) return null;
    if (isDateExpr(value)) {
      const expr = resolveExpr(value, read);
      return expr && resolveDateExpr(expr, config);
    }
    const date = parseDateValue(value as DateInputValue, zone);
    if (!isValid(date)) throw new Error(`Invalid ${label}: ${String(value)}`);
    return date;
  };

  if (DATE_RANGE_OPERATORS.includes(operator)) {
    const [first, second] = readPair(raw, operator);
    const date1 = toPoint(first, 'start date');
    const date2 = toPoint(second, 'end date');
    if (!date1 || !date2) return null;
    const [start, end] = orderPair([date1, date2]);
    const shiftedStart = shift(start);
    const shiftedEnd = shift(end);
    return shiftedStart && shiftedEnd ? [shiftedStart, shiftedEnd] : null;
  }

  if (Array.isArray(raw)) throw new Error(`${operator} operator requires a single date value`);
  // Bare period + before/after ⇒ implied edge (before→start, after→end); the one anchoring
  // rule all three rails share.
  const pointOf = (expr: DateExpr): Date | null => {
    const resolved = resolveExpr(expr, read);
    return resolved && resolvePointForOperator(resolved, operator, config);
  };
  const point = isDateExpr(raw) ? pointOf(raw) : toPoint(raw, 'comparison date');
  if (!point) return null;
  const shifted = shift(point);
  return shifted && [shifted];
};

/**
 * The evaluation's date config with its zone read — the single seam that decides which zone
 * anchors a NAIVE (zoneless) value, frames dayIn/dayNotIn and runs shifts, for ONE evaluation.
 * A zone is a string or a `{ bind }` read from the bindings; one that reads nothing is UTC. It is
 * one zone per evaluation, so a path — which reads the row — has no meaning here. Absolute
 * instants never consult it.
 */
export const resolveDateConfig = (config: DateConfig, read: ReadSource): ResolvedDateConfig => {
  const zone = config.timeZone;
  if (zone === undefined || typeof zone === 'string')
    return { ...config, timeZone: knownZone(zone ?? DEFAULT_ZONE) };
  if (rowRef(zone))
    throw new UsageError(
      `timeZone is one per evaluation; give it as a string or a { bind }, not the row path '${zone.path}'`,
    );
  const read_ = read(zone);
  if (read_ !== null && read_ !== undefined && typeof read_ !== 'string')
    throw new UsageError(`timeZone reads a zone name (got ${String(read_)})`);
  return { ...config, timeZone: knownZone(read_ ?? DEFAULT_ZONE) };
};

/** The zone a `coerceType` reads dates in: the evaluation's zone for a DateTime coercion, as
 *  check() reads one; no other kind reads a zone. */
export const coercionZone = (kind: FieldKind | undefined, opts: EvalOptions): string =>
  kind === 'DateTime'
    ? resolveDateConfig(opts, (source) => readValueSource(source, opts.scopes, opts.bindings))
        .timeZone
    : DEFAULT_ZONE;

// A zone the runtime knows, checked once per name: an unknown one is the caller's input.
const KNOWN_ZONES = new Set<string>();
const knownZone = (zone: string): string => {
  if (KNOWN_ZONES.has(zone)) return zone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new UsageError(`invalid time zone: ${zone}`);
  }
  KNOWN_ZONES.add(zone);
  return zone;
};

// Literal and bound date values compile to concrete Dates through the same parse-and-anchor
// seam check() uses (naive strings → midnight in the zone; instants as-is): a raw 'YYYY-MM-DD'
// is rejected by Prisma and would carry different zone semantics than check().
export const coerceDateLiteral = (value: unknown, zone: string): Date => {
  const parsed = isOrderedValue(value) ? parseDateValue(value, zone) : new Date(Number.NaN);
  if (!isValid(parsed)) throw new Error(`Invalid date value: ${String(value)}`);
  return parsed;
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
