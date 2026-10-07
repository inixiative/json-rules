import dayjs from 'dayjs';
import { resolveUnits } from '../amount';
import { shiftByUnits } from '../dateExpr';
import { addOffset, offsetAmount, offsetShift } from '../offset';
import type { DateOffset, NumberOffset } from '../types';
import type { BuildOptions } from './types';
import { dateConfigOf, prismaRead, readSource } from './valueSource';

// An offset moves the comparison value by what its own value source reads; null when either
// reads nothing. Prisma has no arithmetic, so every side is known at compile time.

export const offsetNumber = (value: unknown, offset: NumberOffset, options?: BuildOptions) => {
  const amount = offsetAmount(readSource(offset, options));
  return amount === null ? null : addOffset(value, amount);
};

export const offsetDate = (
  instant: Date | null,
  offset: DateOffset,
  options?: BuildOptions,
): Date | null => {
  if (instant === null) return null;
  const move = offsetShift(readSource(offset, options));
  const units = move && resolveUnits(move[0], prismaRead(options));
  if (!move || !units) return null;
  return shiftByUnits(dayjs(instant), units, move[1], dateConfigOf(options).timeZone).toDate();
};
