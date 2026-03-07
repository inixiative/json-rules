import { escapeIdentifier } from 'pg';

/**
 * Escape a value for use in a LIKE pattern.
 * Escapes \, %, and _ which are special characters in PostgreSQL LIKE.
 */
export const escapeLikePattern = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
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

  return buildJsonPath(escapeIdentifier(column), jsonPath);
};

/**
 * Quote a field (with possible JSON sub-path) qualified with a table alias.
 *
 * Examples:
 *   quoteQualifiedField('name', 't0')           → "t0"."name"
 *   quoteQualifiedField('data.theme', 't0')      → "t0"."data"->>'theme'
 *   quoteQualifiedField('data.a.b', 't0')        → "t0"."data"->'a'->>'b'
 */
export const quoteQualifiedField = (field: string, alias: string): string => {
  const parts = field.split('.');
  if (parts.length === 1) {
    return `${escapeIdentifier(alias)}.${escapeIdentifier(field)}`;
  }

  const [column, ...jsonPath] = parts;
  return buildJsonPath(`${escapeIdentifier(alias)}.${escapeIdentifier(column)}`, jsonPath);
};

const escapeJsonKey = (key: string) => `'${key.replace(/'/g, "''")}'`;

const buildJsonPath = (columnExpr: string, jsonPath: string[]): string => {
  if (jsonPath.length === 0) return columnExpr;

  const pathParts = jsonPath.slice(0, -1).map(escapeJsonKey).join('->');
  const leaf = escapeJsonKey(jsonPath[jsonPath.length - 1]);

  if (pathParts) {
    return `${columnExpr}->${pathParts}->>${leaf}`;
  }
  return `${columnExpr}->>${leaf}`;
};
