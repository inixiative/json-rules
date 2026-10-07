import { relationsNotValue } from '../errors';
import { FieldKind, isFieldKind } from '../operatorCatalog';
import type { Rule } from '../types';
import type { FieldMap, FieldMapEntry } from './types';
import { fieldEntry, type MapWalkResult, walkWith } from './walk';

/**
 * What a field reads, for the operators whose form depends on it: `text` (a String column),
 * `json` (a whole Json column), `json-path` (inside one), `list` (a scalar list), `relation` (a
 * to-one relation, which exists or not), `relations` (a to-many one, which only array operators
 * read), `scalar` (any other column), or `unknown` (no map, or a path the map doesn't declare).
 */
export type FieldShape =
  | 'relations'
  | 'enum'
  | 'text'
  | 'json'
  | 'json-path'
  | 'list'
  | 'relation'
  | 'scalar'
  | 'unknown';

export const fieldShape = (walk: MapWalkResult | undefined): FieldShape => {
  if (walk?.kind === 'json-path') return 'json-path';
  if (walk?.kind !== 'direct') return 'unknown';
  if (walk.entry.kind === 'object') return walk.entry.isList ? 'relations' : 'relation';
  if (walk.entry.isList) return 'list';
  if (walk.entry.kind === 'enum') return 'enum';
  return kindShape(walk.entry.type);
};

const kindShape = (kind: string): FieldShape => {
  if (kind === FieldKind.Json) return 'json';
  if (kind === FieldKind.Enum) return 'enum';
  return kind === FieldKind.String ? 'text' : 'scalar';
};

/**
 * Whether the emptiness operators may compare a field against `''`. Only a String (or Json)
 * column takes it — Postgres rejects `''` on a timestamp or integer, Prisma rejects
 * `equals: ''` on DateTime/Int/enum. The field map is the authority, a stamped `coerceType`
 * the fallback; with neither, an untyped field keeps its `''` branch.
 */
export const acceptsEmptyString = (
  rule: Pick<Rule, 'field' | 'coerceType'>,
  map: FieldMap | undefined,
  model: string | undefined,
): boolean => {
  const entry = fieldEntry(rule.field, map, model);
  if (entry) return entry.kind === 'scalar' && (entry.type === 'String' || entry.type === 'Json');
  return (
    rule.coerceType === undefined || rule.coerceType === 'String' || rule.coerceType === 'Json'
  );
};

/** A field or date rule on a to-many relation: rows, which an array operator reads. */
export const refuseRelationsValue = (
  field: string,
  map: FieldMap | undefined,
  model: string | undefined,
): void => {
  if (fieldShape(walkWith(field, map, model)) === 'relations') throw relationsNotValue(field);
};

/** A shape whose values read as text (an undeclared field may). */
export const readsText = (shape: FieldShape | undefined): boolean =>
  shape !== 'scalar' &&
  shape !== 'list' &&
  shape !== 'enum' &&
  shape !== 'relation' &&
  shape !== 'relations';

/** Whether a case-insensitive comparison applies — text against a string operand (or a list
 *  holding one), as check() lowercases only strings. */
export const comparesText = (shape: FieldShape | undefined, operand: unknown): boolean =>
  readsText(shape) &&
  (Array.isArray(operand)
    ? operand.some((item) => typeof item === 'string')
    : typeof operand === 'string');

/** A rule's field shape: the map's authority, a stamped `coerceType` the fallback. */
export const ruleShape = (
  rule: Pick<Rule, 'field' | 'coerceType'>,
  map: FieldMap | undefined,
  model: string | undefined,
): FieldShape => {
  const shape = fieldShape(walkWith(rule.field, map, model));
  return shape === 'unknown' && rule.coerceType !== undefined ? kindShape(rule.coerceType) : shape;
};

/** The kind a declared field compares as — undefined where the map does not pin one down:
 *  relations, Json (open-ended), scalar lists, and scalar types outside FieldKind. */
export const entryKind = (entry: FieldMapEntry): FieldKind | undefined => {
  if (entry.isList) return undefined;
  if (entry.kind === 'enum') return FieldKind.Enum;
  if (entry.kind !== 'scalar' || entry.type === FieldKind.Json) return undefined;
  return isFieldKind(entry.type) ? entry.type : undefined;
};
