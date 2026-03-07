import { escapeIdentifier } from 'pg';
import type { FieldMapEntry } from '../toPrisma/types';
import { quoteField, quoteQualifiedField } from './quoting';
import type { BuilderState, FieldMap } from './types';

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
      const existingAlias = state.joinRegistry?.get(registryKey);
      let targetAlias: string;

      if (existingAlias) {
        targetAlias = existingAlias;
      } else {
        const joinCounter = state.joinCounter;
        if (!joinCounter) return quoteField(field);

        targetAlias = `t${++joinCounter.n}`;
        const joinClause = buildJoinClause(
          state.map,
          currentModel,
          currentAlias,
          fieldEntry,
          targetAlias,
        );
        if (!joinClause) return quoteField(field); // fallback: can't determine FK

        state.joins?.push(joinClause);
        state.joinRegistry?.set(registryKey, targetAlias);
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
  targetAlias: string,
): string | null => {
  const targetModel = fieldEntry.type;
  const targetDbName = map[targetModel]?.dbName ?? targetModel;

  let onCondition: string;

  if (
    fieldEntry.fromFields &&
    fieldEntry.fromFields.length > 0 &&
    fieldEntry.toFields &&
    fieldEntry.toFields.length > 0
  ) {
    // Forward relation: current model has FK (composite FK supported via multi-condition AND)
    onCondition = fieldEntry.fromFields
      .map(
        (from, i) =>
          `${escapeIdentifier(targetAlias)}.${escapeIdentifier(fieldEntry.toFields?.[i] ?? '')} = ` +
          `${escapeIdentifier(currentAlias)}.${escapeIdentifier(from)}`,
      )
      .join(' AND ');
  } else {
    // Back-relation: FK is on the target model — find the reverse relation.
    // Pass relationName so multiple relations between the same two models are disambiguated.
    const reverse = findReverseRelation(map, targetModel, currentModel, fieldEntry.relationName);
    if (!reverse) return null;
    onCondition = (reverse.fromFields ?? [])
      .map(
        (from, i) =>
          `${escapeIdentifier(targetAlias)}.${escapeIdentifier(from)} = ` +
          `${escapeIdentifier(currentAlias)}.${escapeIdentifier(reverse.toFields?.[i] ?? '')}`,
      )
      .join(' AND ');
  }

  return `LEFT JOIN ${escapeIdentifier(targetDbName as string)} AS ${escapeIdentifier(targetAlias)} ON ${onCondition}`;
};

const findReverseRelation = (
  map: FieldMap,
  targetModel: string,
  currentModel: string,
  relationName?: string,
): FieldMapEntry | null => {
  const targetEntry = map[targetModel];
  if (!targetEntry) return null;

  for (const fieldDef of Object.values(targetEntry.fields)) {
    if (
      fieldDef.kind === 'object' &&
      fieldDef.type === currentModel &&
      (fieldDef.fromFields?.length ?? 0) > 0 &&
      (fieldDef.toFields?.length ?? 0) > 0 &&
      (relationName === undefined || fieldDef.relationName === relationName)
    ) {
      return fieldDef;
    }
  }
  return null;
};
