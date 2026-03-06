import { escapeIdentifier } from 'pg';
import type { BuilderState, FieldMap } from './types';
import type { FieldMapEntry } from '../toPrisma/types';

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

/**
 * Resolve a dot-notation field to a fully-qualified SQL expression,
 * generating LEFT JOINs for any relation traversals found in the map.
 *
 * Falls back to quoteField() when map/model/alias are not set or a
 * segment is not found in the map.
 *
 * Mutates state.joins, state.joinCounter, and state.joinRegistry.
 */
export const resolveFieldSql = (field: string, state: BuilderState): string => {
  if (!state.map || !state.currentModel || !state.currentAlias) {
    return quoteField(field);
  }

  const parts = field.split('.');
  let currentModel = state.currentModel;
  let currentAlias = state.currentAlias;

  for (let i = 0; i < parts.length; i++) {
    const modelEntry = state.map[currentModel];
    if (!modelEntry) return quoteField(field); // fallback

    const fieldEntry = modelEntry.fields[parts[i]];
    if (!fieldEntry) return quoteField(field); // fallback

    if (fieldEntry.kind === 'object') {
      // Traverse relation: generate (or reuse) a JOIN
      const registryKey = `${currentAlias}.${parts[i]}`;
      let targetAlias: string;

      if (state.joinRegistry?.has(registryKey)) {
        targetAlias = state.joinRegistry.get(registryKey)!;
      } else {
        targetAlias = `t${++state.joinCounter!.n}`;
        const joinClause = buildJoinClause(
          state.map,
          currentModel,
          currentAlias,
          fieldEntry,
          parts[i],
          targetAlias,
        );
        if (!joinClause) return quoteField(field); // fallback: can't determine FK

        state.joins!.push(joinClause);
        state.joinRegistry!.set(registryKey, targetAlias);
      }

      currentModel = fieldEntry.type;
      currentAlias = targetAlias;
      continue;
    }

    // scalar or enum — remaining parts are either the column itself or JSON sub-path
    const remaining = parts.slice(i);
    return quoteQualifiedField(remaining.join('.'), currentAlias);
  }

  // Reached end after only traversing relations (field is the relation itself)
  return quoteField(field);
};

/**
 * Build a LEFT JOIN clause string for a relation field traversal.
 * Returns null when the FK cannot be determined.
 */
const buildJoinClause = (
  map: FieldMap,
  currentModel: string,
  currentAlias: string,
  fieldEntry: FieldMapEntry,
  _fieldName: string,
  targetAlias: string,
): string | null => {
  const targetModel = fieldEntry.type;
  const targetDbName = map[targetModel]?.dbName ?? targetModel;

  let onCondition: string;

  if (fieldEntry.fromFields && fieldEntry.fromFields.length > 0 &&
      fieldEntry.toFields && fieldEntry.toFields.length > 0) {
    // Forward relation: current model has FK
    // JOIN "Target" AS "tN" ON "tN"."toField" = "currentAlias"."fromField"
    onCondition =
      `${escapeIdentifier(targetAlias)}.${escapeIdentifier(fieldEntry.toFields[0])} = ` +
      `${escapeIdentifier(currentAlias)}.${escapeIdentifier(fieldEntry.fromFields[0])}`;
  } else {
    // Back-relation: FK is on the target model — find the reverse relation
    const reverse = findReverseRelation(map, targetModel, currentModel);
    if (!reverse) return null;
    // JOIN "Target" AS "tN" ON "tN"."fkOnTarget" = "currentAlias"."pkOnCurrent"
    onCondition =
      `${escapeIdentifier(targetAlias)}.${escapeIdentifier(reverse.fromFields![0])} = ` +
      `${escapeIdentifier(currentAlias)}.${escapeIdentifier(reverse.toFields![0])}`;
  }

  return `LEFT JOIN ${escapeIdentifier(targetDbName as string)} AS ${escapeIdentifier(targetAlias)} ON ${onCondition}`;
};

const findReverseRelation = (
  map: FieldMap,
  targetModel: string,
  currentModel: string,
): FieldMapEntry | null => {
  const targetEntry = map[targetModel];
  if (!targetEntry) return null;

  for (const fieldDef of Object.values(targetEntry.fields)) {
    if (
      fieldDef.kind === 'object' &&
      fieldDef.type === currentModel &&
      (fieldDef.fromFields?.length ?? 0) > 0 &&
      (fieldDef.toFields?.length ?? 0) > 0
    ) {
      return fieldDef;
    }
  }
  return null;
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
