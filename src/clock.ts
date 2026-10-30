import { assertClockFloor, exprClockUnits, isDateExpr } from './dateExpr';
import { CLOCK_UNITS, type ClockUnit } from './operatorCatalog';
import { visitCondition } from './traverse';
import type { Condition } from './types';

/**
 * The finest clock unit a rule's answer can change by while its data stays the same: the smallest
 * unit any relative date in the tree names (`{ ago: { hours: 2 } }` → `hour`, `{ this: 'week' }`
 * → `week`), at any depth. Null when the rule reads no clock: absolute dates, column compares and
 * their offsets, weekday lists. A bound value (`{ bind }`) is read as written, not as what a
 * binding may supply. Throws on a unit finer than the engine's `clock.finestUnit`, as evaluating
 * the rule does.
 */
export const clockUnit = (condition: Condition): ClockUnit | null => {
  let finest: number | null = null;
  visitCondition(condition, (node) => {
    if (!('dateOperator' in node) || node.value === undefined) return;
    const values = Array.isArray(node.value) ? node.value : [node.value];
    for (const value of values) {
      if (!isDateExpr(value)) continue;
      assertClockFloor(value);
      for (const unit of exprClockUnits(value)) {
        const rank = CLOCK_UNITS.indexOf(unit);
        if (finest === null || rank < finest) finest = rank;
      }
    }
  });
  return finest === null ? null : CLOCK_UNITS[finest];
};
