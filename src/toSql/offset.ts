import { addOffset, offsetAmount, offsetShift } from '../offset';
import type { DateOffset, NumberOffset } from '../types';
import { nextParam } from './params';
import { shiftDate } from './shift';
import type { BuilderState } from './types';
import { isMissing, NO_VALUE, type ResolvedRhs, resolveSource } from './valueSource';

// An offset moves an operand by what its own value source reads. NULL anywhere — base or
// offset — leaves nothing to compare against, as in check().

/** A numeric operand plus an offset, in double precision as check() adds; SQL when either side
 *  is read per row. A range moves at both ends. */
export const offsetNumber = (
  rhs: ResolvedRhs,
  offset: NumberOffset,
  state: BuilderState,
): ResolvedRhs => {
  const by = resolveSource(offset, state);
  if (rhs.type === 'value' && by.type === 'value') {
    const amount = offsetAmount(by.value);
    return amount === null ? NO_VALUE : { type: 'value', value: addOffset(rhs.value, amount) };
  }
  const operand = (side: ResolvedRhs, read: (value: unknown) => unknown) =>
    side.type === 'column'
      ? `(${side.sql})::double precision`
      : `${nextParam(state, read(side.value) ?? null)}::double precision`;
  return {
    type: 'column',
    computed: true,
    sql: `(${operand(rhs, (v) => v)} + ${operand(by, offsetAmount)})`,
  };
};

/** A date operand moved by a date offset's `{ ago }` / `{ ahead }`. A shift stored on the row
 *  is check-only: Postgres has no form for a JSON interval. */
export const offsetDate = (
  rhs: ResolvedRhs,
  offset: DateOffset,
  state: BuilderState,
): ResolvedRhs => {
  if (isMissing(rhs)) return NO_VALUE;
  const by = resolveSource(offset, state);
  if (by.type === 'column')
    throw new Error(
      `A row path on a date offset ('${offset.path}') is check-only; evaluate with check()`,
    );
  const move = offsetShift(by.value);
  return move === null ? NO_VALUE : shiftDate(rhs, ...move, state);
};
