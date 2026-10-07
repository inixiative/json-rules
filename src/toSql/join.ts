import { modelOf, own } from '../own';
import { type MapHop, pastScalarError, walkFieldPath } from '../toPrisma/mapWalk';
import { findReverseRelation } from '../toPrisma/relationUtils';
import type { FieldMapEntry } from '../toPrisma/types';
import { escapeIdentifier } from './escape';
import { quoteField } from './quoting';
import type { BuilderState, FieldMap } from './types';

/**
 * A dot-notation field as SQL. With a map, the path is walked once (walkFieldPath): each relation
 * hop becomes a LEFT JOIN (reused across the query), and the terminal column is qualified by the
 * last hop's alias, with a Json column's tail as a JSON path. Without a map, or for a path the
 * map doesn't declare, the path reads as written. Mutates state.joins / joinCounter / joinRegistry.
 */
export const resolveFieldSql = (
  field: string,
  state: BuilderState,
  { jsonb = false }: { jsonb?: boolean } = {},
): string => {
  if (!state.map || !state.currentModel || !state.currentAlias)
    return quoteField(field, undefined, jsonb);
  const walk = walkFieldPath(field, state.map, state.currentModel);
  if (walk.kind === 'past-scalar') throw pastScalarError(field, walk.column);
  if (walk.kind === 'bridge')
    throw new Error(`'${field}' crosses a bridge to another source; toSql() has no column for it`);
  if (walk.kind === 'fallback' || walk.entry.kind === 'object')
    return quoteField(field, undefined, jsonb);
  let alias = state.currentAlias;
  for (const hop of walk.hops) {
    const joined = joinAlias(state, alias, hop);
    if (!joined) return quoteField(field, undefined, jsonb);
    alias = joined;
  }
  const column = walk.kind === 'json-path' ? [walk.column, ...walk.jsonPath] : [walk.column];
  return quoteField(column.join('.'), alias, jsonb);
};

/** The declared entry a field path ends on, when the map declares it. */
export const terminalEntry = (field: string, state: BuilderState): FieldMapEntry | undefined => {
  if (!state.map || !state.currentModel) return undefined;
  const walk = walkFieldPath(field, state.map, state.currentModel);
  return walk.kind === 'direct' ? walk.entry : undefined;
};

/** The alias a relation hop joins as — reused when the query already joined it. */
const joinAlias = (state: BuilderState, fromAlias: string, hop: MapHop): string | null => {
  const key = `${fromAlias}.${hop.field}`;
  const existing = state.joinRegistry?.get(key);
  if (existing) return existing;
  if (!state.joinCounter || !state.map) return null;
  const alias = `t${state.joinCounter.n + 1}`;
  const clause = buildJoinClause(state.map, hop.from, fromAlias, hop.entry, alias);
  if (!clause) return null;
  state.joinCounter.n += 1;
  state.joins?.push(clause);
  state.joinRegistry?.set(key, alias);
  return alias;
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
  const targetDbName = modelOf(map, targetModel)?.dbName ?? targetModel;

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
