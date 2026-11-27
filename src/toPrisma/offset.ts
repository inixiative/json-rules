import { addOffset, applyDateOffset, offsetAmount } from '../offset';
import type { DateOffset, NumberOffset } from '../types';
import type { ToPrismaOptions } from './types';
import { dateConfigOf, prismaRead, readSource } from './valueSource';

// An offset moves the comparison value by what its own value source reads; null when either
// reads nothing. Prisma has no arithmetic, so every side is known at compile time.

export const offsetNumber = (value: unknown, offset: NumberOffset) => {
  const amount = offsetAmount(readSource(offset));
  return amount === null ? null : addOffset(value, amount);
};

export const offsetDate = (
  instant: Date | null,
  offset: DateOffset,
  options?: ToPrismaOptions,
): Date | null => {
  if (instant === null) return null;
  return applyDateOffset(instant, readSource(offset), prismaRead, dateConfigOf(options).timeZone);
};
