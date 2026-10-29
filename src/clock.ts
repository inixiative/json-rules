import { isDateExpr, isEdgeExpr, namedPeriod, rollingShift } from './dateExpr';
import { engineGlobals } from './engineGlobals';
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
    return Object.keys(rolling[0]).flatMap((unit) =>
      isRelativeUnit(unit) ? [RELATIVE_UNITS[unit].clock] : [],
    );
  const period = isEdgeExpr(expr)
    ? 'start' in expr
      ? expr.start
      : expr.end
    : (expr as PeriodExpr);
  const unit = namedPeriod(period);
  return isPeriodUnit(unit) ? [PERIOD_CLOCK_UNITS[unit]] : [];
};

/**
 * The finest clock unit a rule's answer can change by while its data stays the same: the smallest
 * unit any relative date in the tree names (`{ ago: { hours: 2 } }` → `hour`, `{ this: 'week' }`
 * → `week`), at any depth. Null when the rule reads no clock: absolute dates, column compares and
 * their offsets, weekday lists. A bound value (`{ bind }`) is read as written, not as what a
 * binding may supply. A unit finer than the engine's `clock.finestUnit` reads as that unit.
 */
export const clockUnit = (condition: Condition): ClockUnit | null => {
  let finest: number | null = null;
  visitCondition(condition, (node) => {
    if (!('dateOperator' in node) || node.value === undefined) return;
    const values = Array.isArray(node.value) ? node.value : [node.value];
    for (const value of values) {
      if (!isDateExpr(value)) continue;
      for (const unit of exprClockUnits(value)) {
        const rank = CLOCK_UNITS.indexOf(unit);
        if (finest === null || rank < finest) finest = rank;
      }
    }
  });
  if (finest === null) return null;
  const floor = CLOCK_UNITS.indexOf(engineGlobals.get('clock.finestUnit') as ClockUnit);
  return CLOCK_UNITS[Math.max(finest, floor)];
};
