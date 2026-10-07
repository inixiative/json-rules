import { pastScalarError, toManyHopError } from '../errors';
import { type FieldShape, fieldShape } from '../fieldMap/shape';
import type { FieldMap, FieldMapEntry } from '../fieldMap/types';
import { type MapHop, walkFieldPath } from '../fieldMap/walk';
import { modelOf } from '../own';
import { relationKeys } from '../toPrisma/relationUtils';
import { escapeIdentifier } from './escape';
import { quoteField } from './quoting';
import type { BuilderState } from './types';

/** A field's SQL and what it reads (a JSON path reads text unless `jsonb`). */
export type FieldSql = { sql: string; shape: FieldShape };

/**
 * A dot-notation field as SQL. With a map, the path is walked once (walkFieldPath): each relation
 * hop becomes a LEFT JOIN (reused across the query), and the terminal column is qualified by the
 * last hop's alias, with a Json column's tail as a JSON path. Without a map, or for a path the
 * map doesn't declare, the path reads as written. Mutates state.joins / joinCounter / joinRegistry.
 */
export const resolveField = (
  field: string,
  state: BuilderState,
  { jsonb = false }: { jsonb?: boolean } = {},
): FieldSql => {
  // As written, a dotted path is a JSON path.
  const asWritten = (): FieldSql => ({
    sql: quoteField(field, undefined, jsonb),
    shape: field.includes('.') ? 'json-path' : 'unknown',
  });
  if (!state.map || !state.currentModel || !state.currentAlias) return asWritten();
  const walk = walkFieldPath(field, state.map, state.currentModel);
  if (walk.kind === 'past-scalar') throw pastScalarError(field, walk.column);
  if (walk.kind === 'bridge')
    throw new Error(`'${field}' crosses a bridge to another source; toSql() has no column for it`);
  if (walk.kind === 'fallback' || (walk.entry.kind === 'object' && walk.entry.isList))
    return asWritten();
  const toMany = walk.hops.find((hop) => hop.entry.isList);
  if (toMany) throw toManyHopError(field, toMany);
  let alias = state.currentAlias;
  for (const hop of walk.hops) {
    const joined = joinAlias(state, alias, hop);
    if (!joined) return asWritten();
    alias = joined;
  }
  const shape = fieldShape(walk);
  // A to-one relation as a field reads the joined row's key: NULL when there is no row.
  if (walk.kind === 'direct' && walk.entry.kind === 'object') {
    const hop = { field: walk.column, prefix: field, entry: walk.entry, from: walk.model };
    const keys = relationKeys(state.map, walk.model, walk.entry);
    const joined = joinAlias(state, alias, hop);
    if (!keys || !joined) return asWritten();
    return { sql: `${escapeIdentifier(joined)}.${escapeIdentifier(keys[0].there)}`, shape };
  }
  const column = walk.kind === 'json-path' ? [walk.column, ...walk.jsonPath] : [walk.column];
  const sql = quoteField(column.join('.'), alias, jsonb);
  // A JSON null in a Json column is null, as check() reads it.
  return { sql: shape === 'json' && !jsonb ? `NULLIF(${sql}, 'null'::jsonb)` : sql, shape };
};

export const resolveFieldSql = (
  field: string,
  state: BuilderState,
  options?: { jsonb?: boolean },
): string => resolveField(field, state, options).sql;

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

  const keys = relationKeys(map, currentModel, fieldEntry);
  if (!keys) return null;
  const onCondition = keys
    .map(
      ({ here, there }) =>
        `${escapeIdentifier(targetAlias)}.${escapeIdentifier(there)} = ` +
        `${escapeIdentifier(currentAlias)}.${escapeIdentifier(here)}`,
    )
    .join(' AND ');

  return `LEFT JOIN ${escapeIdentifier(targetDbName as string)} AS ${escapeIdentifier(targetAlias)} ON ${onCondition}`;
};
