import { rollingShift } from './dateExpr';
import { readNumber } from './number';
import type { DateExpr, Magnitude, RelativeUnits } from './types';
import type { ReadSource } from './valueSource';

// A unit amount in a date expression: a literal number or a value source that reads one.

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

const fitsUnit = (amount: number, unit: string): boolean =>
  amount >= 0 && (!isCalendarUnit(unit) || Number.isInteger(amount));

/**
 * A unit amount's number. A supplied amount — literal, `{ value }` or `{ bind }` — that the unit
 * can't take is a caller error and throws. One read from data by `{ path }` — negative, or
 * fractional on a calendar unit — reads as null, as does nothing at all, so the comparison
 * fails closed on every rail.
 */
export const resolveMagnitude = (
  magnitude: Magnitude,
  read: ReadSource,
  unit: keyof RelativeUnits,
): number | null => {
  const amount =
    typeof magnitude === 'number'
      ? magnitude
      : readNumber(read(magnitude), magnitude.path ? `'${magnitude.path}' (${unit})` : unit);
  if (amount === null || fitsUnit(amount, unit)) return amount;
  if (typeof magnitude !== 'number' && magnitude.path !== undefined) return null;
  throw new Error(
    `${unit} must be a non-negative${isCalendarUnit(unit) ? ' whole' : ''} number (got ${amount})`,
  );
};

/** Units with every amount read, or null when one reads nothing usable. */
export const resolveUnits = (
  units: RelativeUnits,
  read: ReadSource,
): RelativeUnits<number> | null => {
  const resolved: RelativeUnits<number> = {};
  for (const [unit, magnitude] of Object.entries(units) as [keyof RelativeUnits, Magnitude][]) {
    if (magnitude === undefined) continue;
    const amount = resolveMagnitude(magnitude, read, unit);
    if (amount === null) return null;
    resolved[unit] = amount;
  }
  return resolved;
};

/** A date expression with its amounts read, or null when one reads nothing. */
export const resolveExpr = (expr: DateExpr, read: ReadSource): DateExpr<number> | null => {
  const rolling = rollingShift(expr);
  if (!rolling) return expr as DateExpr<number>;
  const units = resolveUnits(rolling[0], read);
  if (!units) return null;
  return rolling[1] === -1 ? { ago: units } : { ahead: units };
};
