import type { FieldMapEntry } from '../toPrisma/types';
import { escapeIdentifier } from './escape';
import { quoteField, quoteQualifiedField } from './quoting';
import type { BuilderState, FieldMap } from './types';

// gloss
export const resolveFieldSql = (field: string, state: BuilderState): string => {
  if (!state.map || !state.currentModel || !state.currentAlias) {
    return quoteField(field);
  }

  const parts = field.split('.');
  let currentModel = state.currentModel;
  let currentAlias = state.currentAlias;

  for (let i = 0; i < parts.length; i++) {
    const modelEntry = state.map.models[currentModel];
    if (!modelEntry) return quoteField(field);

    const fieldEntry = modelEntry.fields[parts[i]];
    if (!fieldEntry) return quoteField(field);

    if (fieldEntry.kind === 'object') {
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
        if (!joinClause) return quoteField(field);

        state.joins?.push(joinClause);
        state.joinRegistry?.set(registryKey, targetAlias);
      }

      currentModel = fieldEntry.type;
      currentAlias = targetAlias;
      continue;
    }

    const remaining = parts.slice(i);
    return quoteQualifiedField(remaining.join('.'), currentAlias);
  }

  return quoteField(field);
};

// gloss
const buildJoinClause = (
  map: FieldMap,
  currentModel: string,
  currentAlias: string,
  fieldEntry: FieldMapEntry,
  targetAlias: string,
): string | null => {
  const targetModel = fieldEntry.type;
  const targetDbName = map.models[targetModel]?.dbName ?? targetModel;

  let onCondition: string;

  if (
    fieldEntry.fromFields &&
    fieldEntry.fromFields.length > 0 &&
    fieldEntry.toFields &&
    fieldEntry.toFields.length > 0
  ) {
    onCondition = fieldEntry.fromFields
      .map(
        (from, i) =>
          `${escapeIdentifier(targetAlias)}.${escapeIdentifier(fieldEntry.toFields?.[i] ?? '')} = ` +
          `${escapeIdentifier(currentAlias)}.${escapeIdentifier(from)}`,
      )
      .join(' AND ');
  } else {
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
  const targetEntry = map.models[targetModel];
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
