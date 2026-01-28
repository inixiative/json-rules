import { escapeIdentifier } from 'pg';
import type { BuilderState } from './types';

export const nextParam = (state: BuilderState, value: unknown): string => {
  state.params.push(value);
  return `$${++state.paramIndex}`;
};

/**
 * Escape a value for use in a LIKE pattern.
 * Escapes \, %, and _ which are special characters in PostgreSQL LIKE.
 */
export const escapeLikePattern = (value: string): string => {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
};

/**
 * Quote a field name as a SQL identifier, handling JSON paths.
 * Uses pg's escapeIdentifier for proper SQL injection prevention.
 *
 * Examples:
 *   "name" → "name"
 *   "data.theme" → "data"->>'theme'
 *   "settings.display.mode" → "settings"->'display'->>'mode'
 */
export const quoteField = (field: string): string => {
  const parts = field.split('.');
  if (parts.length === 1) return escapeIdentifier(field);

  const [column, ...jsonPath] = parts;
  if (jsonPath.length === 0) return escapeIdentifier(column);

  // Build JSON path: "column"->'path1'->'path2'->>'leaf'
  // JSON keys need single quote escaping ('' for literal ')
  const escapeJsonKey = (key: string) => `'${key.replace(/'/g, "''")}'`;

  const pathParts = jsonPath.slice(0, -1).map(escapeJsonKey).join('->');
  const leaf = escapeJsonKey(jsonPath[jsonPath.length - 1]);

  if (pathParts) {
    return `${escapeIdentifier(column)}->${pathParts}->>${leaf}`;
  }
  return `${escapeIdentifier(column)}->>${leaf}`;
};

export const mapDayNames = (days: string[]): number[] => {
  const dayMap: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
  };
  return days.map((d) => {
    const num = dayMap[d.toLowerCase()];
    if (num === undefined) throw new Error(`Unknown day name: ${d}`);
    return num;
  });
};
