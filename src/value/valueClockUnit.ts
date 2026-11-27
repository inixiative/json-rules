import { clockUnit, clockUnitsOf, finestClockUnit, writtenOffset } from '../clock';
import type { ClockUnit } from '../operatorCatalog';
import { listItems, valueExpressionShape } from '../traverse';
import type { Condition, ValueExpression } from '../types';

const collectClockUnits = (expr: unknown, out: ClockUnit[]): void => {
  const node = expr as Record<string, unknown>;
  switch (valueExpressionShape(expr)) {
    case 'date':
      out.push(...clockUnitsOf(expr));
      return;
    case 'source':
      if (node.offset !== undefined)
        out.push(...clockUnitsOf(node.value, writtenOffset(node.offset)));
      return;
    case 'list':
      for (const item of listItems(expr)) collectClockUnits(item, out);
      return;
    case 'if': {
      const condUnit = clockUnit(node.if as Condition);
      if (condUnit) out.push(condUnit);
      collectClockUnits(node.then, out);
      if (node.else !== undefined) collectClockUnits(node.else, out);
      return;
    }
    case 'aggregate': {
      const aggUnit = clockUnit(node as Condition);
      if (aggUnit) out.push(aggUnit);
      return;
    }
    default:
      return;
  }
};

/**
 * The finest clock unit a value expression's answer can change by while its data stays the same —
 * over every date expression it computes and every condition it holds (an `if`, an aggregate's
 * `filter` / `condition`), so `{ ahead: { weeks: 1 } }` reads `week` and an aggregate over the
 * last 90 days reads `day`. Null when it reads no clock. Throws, as `clockUnit` does, on a unit
 * finer than `clock.finestUnit` (including date offsets on absolute dates).
 */
export const valueClockUnit = (expression: ValueExpression): ClockUnit | null => {
  const units: ClockUnit[] = [];
  collectClockUnits(expression, units);
  return finestClockUnit(units);
};
