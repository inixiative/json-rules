import { clockUnit } from '../clock';
import type { ClockUnit } from '../operatorCatalog';
import { valueReads } from '../traverse';
import type { ValueExpression } from '../types';

/**
 * The finest clock unit a value expression's answer can change by while its data stays the same —
 * `clockUnit` over every condition it holds (an `if`, an aggregate's `filter` / `condition`), so
 * an aggregate over the last 90 days reads `day`. Null when it reads no clock. Throws, as
 * `clockUnit` does, on a unit finer than `clock.finestUnit`.
 */
export const valueClockUnit = (expression: ValueExpression): ClockUnit | null =>
  clockUnit(valueReads(expression));
