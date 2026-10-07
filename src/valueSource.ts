import { readBinding } from './bindings';
import { isDateExpr, isRollingExpr, rollingShift } from './dateExpr';
import { DateOperator, Operator } from './operator';
import { readPath, type Scopes } from './scope';
import type { DateExpr, Magnitude, PathRef, RelativeUnits, RuleValue } from './types';

// A leaf's comparison operand: one of `value` / `bind` / `path`, optionally moved by an
// `offset`, with relative-date magnitudes that may themselves be `{ path }` refs.

type Sourced = { value?: unknown; path?: string; bind?: string; bindOptional?: boolean };

/** check(): the comparison value — the literal, the bound value, or the path read. */
export const readValueSource = (
  rule: Sourced,
  scopes: Scopes,
  context: unknown,
  bindings?: Record<string, RuleValue>,
): unknown => {
  if (rule.value !== undefined) return rule.value;
  if (rule.bind !== undefined) return readBinding(rule.bind, rule.bindOptional, bindings);
  if (rule.path) return readPath(rule.path, scopes, context);
  throw new Error('No value or path specified');
};

/** The operators an offset can shift: one point, or both ends of a range. */
export const OFFSET_OPERATORS: readonly string[] = [
  Operator.equals,
  Operator.notEquals,
  Operator.lessThan,
  Operator.lessThanEquals,
  Operator.greaterThan,
  Operator.greaterThanEquals,
  Operator.between,
  Operator.notBetween,
  DateOperator.before,
  DateOperator.after,
  DateOperator.onOrBefore,
  DateOperator.onOrAfter,
  DateOperator.notBefore,
  DateOperator.notAfter,
];

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

export const isPathRef = (v: unknown): v is PathRef =>
  isPlainObject(v) && typeof v.path === 'string';

// Calendar units shift by whole steps; time units by any amount. Every unit is non-negative —
// direction lives in `ago` / `ahead`.
const CALENDAR_UNITS: ReadonlySet<string> = new Set([
  'years',
  'quarters',
  'months',
  'weeks',
  'days',
]);
export const isCalendarUnit = (unit: string): boolean => CALENDAR_UNITS.has(unit);

/** How a value-side ref is read: the comparison value itself, a number, a whole number, or a
 *  date offset's rolling shift. */
export type ValueRef = { ref: string; role: 'value' | 'number' | 'whole' | 'shift' };

const unitRefs = (units: unknown): ValueRef[] =>
  isPlainObject(units)
    ? Object.entries(units).flatMap(([unit, magnitude]) =>
        isPathRef(magnitude)
          ? [{ ref: magnitude.path, role: isCalendarUnit(unit) ? 'whole' : 'number' } as ValueRef]
          : [],
      )
    : [];

const exprRefs = (expr: unknown): ValueRef[] =>
  isDateExpr(expr) && isRollingExpr(expr) ? unitRefs('ago' in expr ? expr.ago : expr.ahead) : [];

const offsetRefs = (cond: Record<string, unknown>): ValueRef[] => {
  const { offset } = cond;
  if (!isPlainObject(offset)) return [];
  if (typeof offset.path === 'string')
    return [{ ref: offset.path, role: 'dateOperator' in cond ? 'shift' : 'number' }];
  return exprRefs(offset.value);
};

/** Every ref on a leaf's value side, with how it is read: its `path`, its offset's `path`, and
 *  each `{ path }` magnitude. */
export const valueRefRoles = (cond: Record<string, unknown>): ValueRef[] => {
  const { path, value } = cond;
  const values = Array.isArray(value) ? value : [value];
  return [
    ...(typeof path === 'string' && path !== '' ? [{ ref: path, role: 'value' } as ValueRef] : []),
    ...offsetRefs(cond),
    ...values.flatMap(exprRefs),
  ];
};

/** The refs a leaf reads beyond its comparison value: its offset's and its magnitudes'. */
export const magnitudeRefs = (cond: Record<string, unknown>): string[] =>
  valueRefRoles(cond)
    .filter((r) => r.role !== 'value')
    .map((r) => r.ref);

/** Every ref on a leaf's value side: its `path` and its magnitude refs. */
export const valueRefs = (cond: Record<string, unknown>): string[] =>
  valueRefRoles(cond).map((r) => r.ref);

// BigInt compares as Int: a bigint (what Prisma returns for a BigInt column) becomes a JS
// number on every side of a comparison, so 5n matches 5. Past ±2^53 a number cannot hold it
// exactly and every comparison would be silently wrong, so that throws instead.
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export const bigIntToNumber = (value: bigint): number => {
  if (value > MAX_SAFE || value < -MAX_SAFE)
    throw new RangeError(
      `BigInt ${value} is outside the safe integer range (±2^53); json-rules compares BigInt as Int.`,
    );
  return Number(value);
};

/** A read for `{ path }` amounts: the row/scope on check(), context on the compilers. */
export type ReadRef = (ref: string) => unknown;

const toNumber = (raw: unknown): unknown => {
  if (typeof raw === 'bigint') return bigIntToNumber(raw);
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)))
    return Number(raw);
  return raw;
};

/**
 * A magnitude's number. A literal a `unit` can't take is an authoring error and throws. A value read from data
 * that a `unit` can't take — negative, or fractional on a calendar unit — reads as null, as does
 * nothing at all, so the comparison fails closed on every rail; a non-number is a caller bug.
 */
export const resolveMagnitude = (
  magnitude: Magnitude,
  read: ReadRef,
  unit?: keyof RelativeUnits,
): number | null => {
  if (!isPathRef(magnitude)) {
    if (
      unit !== undefined &&
      (magnitude < 0 || (isCalendarUnit(unit) && !Number.isInteger(magnitude)))
    )
      throw new Error(
        `${unit} must be a non-negative${isCalendarUnit(unit) ? ' whole' : ''} number (got ${magnitude})`,
      );
    return magnitude;
  }
  const raw = read(magnitude.path);
  if (raw === null || raw === undefined) return null;
  const value = toNumber(raw);
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`'${magnitude.path}' must read a number (got ${String(raw)})`);
  if (unit === undefined) return value;
  if (value < 0 || (isCalendarUnit(unit) && !Number.isInteger(value))) return null;
  return value;
};

/** Units with every magnitude resolved, or null when one reads nothing usable. */
export const resolveUnits = (units: RelativeUnits, read: ReadRef): RelativeUnits | null => {
  const resolved: RelativeUnits = {};
  for (const [unit, magnitude] of Object.entries(units) as [keyof RelativeUnits, Magnitude][]) {
    if (magnitude === undefined) continue;
    const amount = resolveMagnitude(magnitude, read, unit);
    if (amount === null) return null;
    resolved[unit] = amount;
  }
  return resolved;
};

/** A date expression with its rolling magnitudes resolved, or null when one reads nothing. */
export const resolveExpr = (expr: DateExpr, read: ReadRef): DateExpr | null => {
  if (!isRollingExpr(expr)) return expr;
  if ('ago' in expr) {
    const ago = resolveUnits(expr.ago, read);
    return ago && { ago };
  }
  const ahead = resolveUnits(expr.ahead, read);
  return ahead && { ahead };
};

/**
 * A comparison value moved by a resolved numeric offset. A range moves at both ends, and a
 * range missing an end is null — nothing to compare against.
 */
export const addOffset = (value: unknown, offset: number): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const ends = value.map((item) => addOffset(item, offset));
    return ends.some((end) => end === null) ? null : ends;
  }
  const number = toNumber(value);
  if (typeof number !== 'number' || !Number.isFinite(number))
    throw new Error(`offset needs a numeric comparison value (got ${String(value)})`);
  return number + offset;
};

/** A numeric offset's amount, read from its source; null when it reads nothing. */
export const offsetAmount = (raw: unknown): number | null => {
  if (raw === null || raw === undefined) return null;
  const amount = toNumber(raw);
  if (typeof amount !== 'number' || !Number.isFinite(amount))
    throw new Error(`an offset reads a number (got ${String(raw)})`);
  return amount;
};

/** A date offset's rolling shift, read from its source; null when it reads nothing. */
export const offsetShift = (raw: unknown): [RelativeUnits, 1 | -1] | null => {
  if (raw === null || raw === undefined) return null;
  const rolling = isDateExpr(raw) ? rollingShift(raw) : null;
  if (!rolling)
    throw new Error(`a date offset reads { ago } or { ahead } (got ${JSON.stringify(raw)})`);
  return rolling;
};
