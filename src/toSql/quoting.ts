import { escapeIdentifier } from './escape';

// gloss
export const escapeLikePattern = (value: string): string => {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
};

// gloss
export const quoteField = (field: string): string => {
  const parts = field.split('.');
  if (parts.length === 1) return escapeIdentifier(field);

  const [column, ...jsonPath] = parts;
  if (jsonPath.length === 0) return escapeIdentifier(column);

  return buildJsonPath(escapeIdentifier(column), jsonPath);
};

// gloss
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

// gloss
export const quoteFieldAsJsonb = (field: string): string => {
  const parts = field.split('.');
  if (parts.length === 1) return escapeIdentifier(field);

  const [column, ...jsonPath] = parts;
  if (jsonPath.length === 0) return escapeIdentifier(column);

  return buildJsonPathJsonb(escapeIdentifier(column), jsonPath);
};

const buildJsonPathJsonb = (columnExpr: string, jsonPath: string[]): string => {
  const allParts = jsonPath.map(escapeJsonKey).join('->');
  return `${columnExpr}->${allParts}`;
};
