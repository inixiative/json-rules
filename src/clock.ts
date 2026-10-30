import { castArray, isPlainObject } from 'lodash-es';
import { isDateExpr, isEdgeExpr, namedPeriod, rollingShift } from './dateExpr';
import { engineGlobals } from './engineGlobals';
import { clockUnitBelowFloor, UsageError } from './errors';
import {
  CLOCK_UNITS,
  type ClockUnit,
  isPeriodUnit,
  isRelativeUnit,
  PERIOD_CLOCK_UNITS,
  RELATIVE_UNITS,
} from './operatorCatalog';
import { visitCondition } from './traverse';
import type { Condition, DateExpr, PeriodExpr } from './types';

// The clock units one date expression reads: a rolling one each unit it names, a period or an
// edge its period's unit. An unknown unit reads nothing here; validateRule reports it.
const exprClockUnits = (expr: DateExpr<unknown>): ClockUnit[] => {
  const rolling = rollingShift(expr);
  if (rolling)
    return isPlainObject(rolling[0])
      ? Object.keys(rolling[0]).flatMap((unit) =>
          isRelativeUnit(unit) ? [RELATIVE_UNITS[unit].clock] : [],
        )
      : [];
  const period = isEdgeExpr(expr) ? ('start' in expr ? expr.start : expr.end) : expr;
  if (!isPlainObject(period)) return [];
  const unit = namedPeriod(period as PeriodExpr);
  return isPeriodUnit(unit) ? [PERIOD_CLOCK_UNITS[unit]] : [];
};

// Every unit a comparison names: its relative dates (a range's ends included) and its offset.
const comparisonUnits = (value: unknown, offset: unknown): ClockUnit[] =>
  [...castArray(value), offset].filter(isDateExpr).flatMap(exprClockUnits);

// A comparison reads the clock when its value, or an end of its range, is a relative date.
const readsClock = (value: unknown): boolean => castArray(value).some(isDateExpr);

const rank = (unit: ClockUnit): number => CLOCK_UNITS.indexOf(unit);

// The engine's floor, singular or plural; anything else would switch the floor off unseen.
const clockFloor = (): ClockUnit => {
  const floor = engineGlobals.get('clock.finestUnit');
  if ((CLOCK_UNITS as readonly unknown[]).includes(floor)) return floor as ClockUnit;
  if (typeof floor === 'string' && isRelativeUnit(floor)) return RELATIVE_UNITS[floor].clock;
  throw new UsageError(
    `clock.finestUnit reads a clock unit, singular or plural (got ${String(floor)})`,
  );
};

/** The error a date comparison raises when any unit it names, in its value or its offset as
 *  read, is finer than the engine's `clock.finestUnit`; null when none is. */
export const clockFloorError = (value: unknown, offset?: unknown): Error | null => {
  const units = comparisonUnits(value, offset);
  if (units.length === 0) return null;
  const floor = clockFloor();
  const finer = units.find((unit) => rank(unit) < rank(floor));
  return finer ? clockUnitBelowFloor(finer, floor) : null;
};

/** A date rule's offset as written: a bound or row-read one is not known until evaluation. */
export const writtenOffset = (offset: unknown): unknown =>
  isPlainObject(offset) ? (offset as { value?: unknown }).value : undefined;

/**
 * The finest clock unit a rule's answer can change by while its data stays the same: the smallest
 * unit any relative date in the tree names, or the offset moving one (`{ ago: { hours: 2 } }` →
 * `hour`, `{ this: 'week' }` → `week`), at any depth. Null when the rule reads no clock: absolute
 * dates, column compares and their offsets, weekday lists. A bound value (`{ bind }`) is read as
 * written, not as what a binding may supply. Throws when any unit the rule names, offsets
 * included, is finer than the engine's `clock.finestUnit`, as evaluating the rule does.
 */
export const clockUnit = (condition: Condition): ClockUnit | null => {
  let finest: number | null = null;
  visitCondition(condition, (node) => {
    if (!('dateOperator' in node)) return;
    const offset = writtenOffset(node.offset);
    const error = clockFloorError(node.value, offset);
    if (error) throw error;
    if (!readsClock(node.value)) return;
    for (const unit of comparisonUnits(node.value, offset))
      if (finest === null || rank(unit) < finest) finest = rank(unit);
  });
  return finest === null ? null : CLOCK_UNITS[finest];
};
