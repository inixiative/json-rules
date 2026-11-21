import type { PrismaWhere } from './types';

/**
 * Build a nested Prisma filter from a dot-notation field path.
 *
 * In Prisma, dot-notation always means relation traversal (unlike toSql where
 * dots mean JSON path). Each segment wraps the next from the inside out.
 *
 * @example
 * buildNestedFilter('status', { equals: 'active' })
 * // → { status: { equals: 'active' } }
 *
 * buildNestedFilter('user.profile.bio', { contains: 'hello' })
 * // → { user: { profile: { bio: { contains: 'hello' } } } }
 */
export const nestUnderPath = (field: string, leaf: unknown): Record<string, unknown> => {
  const parts = field.split('.');
  let result: unknown = leaf;
  for (let i = parts.length - 1; i >= 0; i--) {
    result = { [parts[i] as string]: result };
  }
  return result as Record<string, unknown>;
};

/** A filter nested under its dotted field: `nestUnderPath`, as a Prisma where. */
export const buildNestedFilter = (field: string, filter: unknown): PrismaWhere =>
  nestUnderPath(field, filter) as PrismaWhere;
