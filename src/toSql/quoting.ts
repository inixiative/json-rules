import { escapeIdentifier } from './escape';

/**
 * Escape a value for use in a LIKE pattern.
 * Escapes \, %, and _ which are special characters in PostgreSQL LIKE.
 */
export const escapeLikePattern = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
};

/**
 * A field as SQL: its column, then any JSON sub-path. The leaf reads as text (`->>`), or as
 * JSONB (`->`) when the result feeds a JSONB function such as jsonb_array_elements().
 *
 *   "name"                → "name"
 *   "data.theme"          → "data"->>'theme'        (jsonb: "data"->'theme')
 *   "settings.display.mode" → "settings"->'display'->>'mode'
 *   with an alias          → "t0"."data"->>'theme'
 */
export const quoteField = (field: string, alias?: string, jsonb = false): string => {
  const [column, ...jsonPath] = field.split('.');
  const columnExpr = alias
    ? `${escapeIdentifier(alias)}.${escapeIdentifier(column)}`
    : escapeIdentifier(column);
  if (jsonPath.length === 0) return columnExpr;
  const keys = jsonPath.map(jsonKey);
  const leaf = keys.pop() as string;
  return [columnExpr, ...keys].join('->') + (jsonb ? '->' : '->>') + leaf;
};

/** A JSON key as a SQL string literal. */
export const jsonKey = (key: string): string => `'${key.replace(/'/g, "''")}'`;
