import type { PrismaWhere } from './types';

// gloss
export const buildNestedFilter = (field: string, filter: unknown): PrismaWhere => {
  const parts = field.split('.');
  let result: unknown = filter;
  for (let i = parts.length - 1; i >= 0; i--) {
    result = { [parts[i]]: result };
  }
  return result as PrismaWhere;
};
