import { applyCoercion } from '../field';
import { isJsonEntry } from '../fieldMap/entry';
import { COMPILE_COERCED_KINDS, FieldKind, NUMERIC_KINDS } from '../operatorCatalog';
import { modelOf, own } from '../own';
import { someCondition } from '../traverse';
import type { Condition, Rule } from '../types';
import type { FieldMap, FieldMapEntry } from './types';

/** A relation the walk crossed on the way to the terminal segment. */
export type MapHop = { field: string; prefix: string; entry: FieldMapEntry; from: string };

/**
 * A dot-notation field path walked through a FieldMap — the one walk both compilers use:
 * - `direct`      the path ends on a declared field (`entry`), a column of `model` or a relation
 * - `json-path`   it reaches a Json column (`column`) and continues as a JSON path
 * - `bridge`      it crosses a bridge to another source
 * - `past-scalar` it continues past a non-Json column, which has no sub-fields
 * - `fallback`    a segment isn't declared; the compilers read the path as written
 * `hops` are the relations crossed before the terminal segment, outermost first.
 */
export type MapWalkResult =
  | { kind: 'direct'; hops: MapHop[]; entry: FieldMapEntry; model: string; column: string }
  | {
      kind: 'json-path';
      hops: MapHop[];
      entry: FieldMapEntry;
      model: string;
      column: string;
      stopIndex: number;
      jsonPath: string[];
    }
  | { kind: 'bridge'; hops: MapHop[] }
  | { kind: 'past-scalar'; hops: MapHop[]; column: string }
  | { kind: 'fallback'; hops: MapHop[] };

export const walkFieldPath = (field: string, map: FieldMap, rootModel: string): MapWalkResult => {
  const parts = field.split('.');
  const hops: MapHop[] = [];
  let model = rootModel;
  for (let i = 0; i < parts.length; i++) {
    const entry = own(modelOf(map, model)?.fields, parts[i]);
    if (!entry) return { kind: 'fallback', hops };
    if (entry.kind === 'bridge') return { kind: 'bridge', hops };
    const last = i === parts.length - 1;
    if (entry.kind === 'object') {
      if (!modelOf(map, entry.type)) return { kind: 'fallback', hops };
      if (last) return { kind: 'direct', hops, entry, model, column: parts[i] };
      hops.push({ field: parts[i], prefix: parts.slice(0, i + 1).join('.'), entry, from: model });
      model = entry.type;
      continue;
    }
    if (last) return { kind: 'direct', hops, entry, model, column: parts[i] };
    if (isJsonEntry(entry))
      return {
        kind: 'json-path',
        hops,
        entry,
        model,
        column: parts[i],
        stopIndex: i + 1,
        jsonPath: parts.slice(i + 1),
      };
    return { kind: 'past-scalar', hops, column: parts[i] };
  }
  return { kind: 'fallback', hops };
};

/** A field's walk, when a map and model are given. */
export const walkWith = (
  field: string,
  map: FieldMap | undefined,
  model: string | undefined,
): MapWalkResult | undefined => (map && model ? walkFieldPath(field, map, model) : undefined);

/** The declared entry a field path ends on, when the map declares it. */
export const fieldEntry = (
  field: string,
  map: FieldMap | undefined,
  model: string | undefined,
): FieldMapEntry | undefined => {
  const walk = walkWith(field, map, model);
  return walk?.kind === 'direct' ? walk.entry : undefined;
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

/**
 * The dotted prefixes of `field` that end on an OPTIONAL to-one relation, outermost first —
 * every hop at which the path can be absent as a whole. Same licensing authority as
 * `isRequired` on a column.
 */
export const optionalToOneHops = (field: string, map: FieldMap, rootModel: string): string[] =>
  walkFieldPath(field, map, rootModel)
    .hops.filter((hop) => !hop.entry.isList && hop.entry.isRequired === false)
    .map((hop) => hop.prefix);

/**
 * What a field reads, for the operators whose form depends on it: `text` (a String column),
 * `json` (a whole Json column), `json-path` (inside one), `list` (a scalar list), `relation` (a
 * to-one relation, which exists or not), `scalar` (any other column), or `unknown` (no map, a
 * path the map doesn't declare, or a to-many relation).
 */
export type FieldShape =
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
  if (walk.entry.kind === 'object') return walk.entry.isList ? 'unknown' : 'relation';
  if (walk.entry.isList) return 'list';
  if (walk.entry.kind === 'enum') return 'enum';
  return kindShape(walk.entry.type);
};

const kindShape = (kind: string): FieldShape => {
  if (kind === FieldKind.Json) return 'json';
  if (kind === FieldKind.Enum) return 'enum';
  return kind === FieldKind.String ? 'text' : 'scalar';
};

/** A shape whose values read as text (an undeclared field may). */
export const readsText = (shape: FieldShape | undefined): boolean =>
  shape !== 'scalar' && shape !== 'list' && shape !== 'enum' && shape !== 'relation';

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

/** A to-many relation inside a plain field path: which child it reads is undefined. */
export const toManyHopError = (field: string, hop: MapHop): Error =>
  new Error(
    `'${field}' reads through the to-many relation '${hop.prefix}'; compare its rows with an arrayOperator rule on '${hop.prefix}'.`,
  );

/** The error for a path that continues past a non-Json column. */
export const pastScalarError = (field: string, column: string): Error =>
  new Error(`'${field}' continues past '${column}', which is not a Json column`);

/** The kind a declared field compares as — undefined where the map does not pin one down:
 *  relations, Json (open-ended), scalar lists, and scalar types outside FieldKind. */
export const entryKind = (entry: FieldMapEntry): FieldKind | undefined => {
  if (entry.isList) return undefined;
  if (entry.kind === 'enum') return FieldKind.Enum;
  if (entry.kind !== 'scalar' || entry.type === FieldKind.Json) return undefined;
  return Object.hasOwn(FieldKind, entry.type) ? (entry.type as FieldKind) : undefined;
};

/** Epoch ms of a DateTime literal through check()'s own DateTime coercion (Date, ISO with or
 *  without a zone, day-only, epoch ms or digits; zoneless anchors in UTC) — undefined when it
 *  is not a representable instant. The gate and both compilers read dates through this seam. */
export const instantMs = (value: unknown, zone?: string): number | undefined => {
  const ms = applyCoercion(value, FieldKind.DateTime, zone);
  return typeof ms === 'number' && !Number.isNaN(new Date(ms).getTime()) ? ms : undefined;
};

// Prisma takes a Date. toSql takes the zoned ISO string: a pg driver serializes a Date param in
// the HOST's zone, which a `timestamp` (no time zone) column — Prisma's Postgres default —
// silently drops; a `...Z` string casts to the same instant on either column type.
const toInstant =
  (field: string, target: CompileTarget, zone: string) =>
  (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    const ms = instantMs(value, zone);
    if (ms === undefined)
      throw new Error(`Invalid date value for DateTime field '${field}': ${String(value)}`);
    return target === 'toPrisma' ? new Date(ms) : new Date(ms).toISOString();
  };

type CompileTarget = 'toPrisma' | 'toSql';

/**
 * A field rule's comparison value as a compiler must emit it for the column `walk` reached. The
 * compiled query compares the column as stored, so a `coerceType` that overrides the declared
 * kind has no compiled equivalent and throws; a stamp equal to it coerces the literal the way
 * check() does. A DateTime column (declared, or a stamped `coerceType` when no map is passed)
 * gets its literals as instants. A Json sub-path or a scalar list declares no kind: unchanged.
 */
export const compileFieldLiteral = (
  rule: Pick<Rule, 'field' | 'coerceType'>,
  value: unknown,
  walk: MapWalkResult | undefined,
  target: CompileTarget,
  zone: () => string,
): unknown => {
  if (value === null || value === undefined || walk?.kind === 'json-path') return value;
  const entry = walk?.kind === 'direct' ? walk.entry : undefined;
  if (entry?.isList) return value;
  const declared = entry ? entryKind(entry) : undefined;
  if (rule.coerceType !== undefined && declared !== undefined && rule.coerceType !== declared)
    throw new Error(
      `coerceType '${rule.coerceType}' overrides ${declared} field '${rule.field}', but ${target} compares the column as stored — evaluate it in memory with check(), or drop the override.`,
    );
  const kind = declared ?? rule.coerceType;
  if (kind === FieldKind.DateTime) {
    const instant = toInstant(rule.field, target, zone());
    return Array.isArray(value) ? value.map(instant) : instant(value);
  }
  // Unstamped, check() compares the literal as written, so a string never equals a number or a
  // boolean column; the compilers would cast it. Refuse it — stamp `coerceType` to compare it.
  if (
    rule.coerceType === undefined &&
    declared !== undefined &&
    (NUMERIC_KINDS.includes(declared) || declared === FieldKind.Boolean) &&
    (Array.isArray(value) ? value : [value]).some((item) => typeof item === 'string')
  )
    throw new Error(
      `'${rule.field}' is ${declared} but the literal is a string; pass a ${declared === FieldKind.Boolean ? 'boolean' : 'number'}, or stamp coerceType: '${declared}'.`,
    );
  return rule.coerceType !== undefined && COMPILE_COERCED_KINDS.includes(rule.coerceType)
    ? applyCoercion(
        value,
        rule.coerceType,
        rule.coerceType === FieldKind.DateTime ? zone() : undefined,
      )
    : value;
};

/** The model a path of relations leads to; null when a segment isn't a declared relation. */
export const relationTarget = (field: string, map: FieldMap, model: string): string | null => {
  const walk = walkFieldPath(field, map, model);
  return walk.kind === 'direct' && walk.entry?.kind === 'object' ? walk.entry.type : null;
};

/** Whether a field path crosses a bridge. */
export const hitsBridge = (field: string, map: FieldMap, model: string): boolean =>
  walkFieldPath(field, map, model).kind === 'bridge';

/**
 * Whether a bridge appears anywhere in a condition, a relation node's `condition` / `filter`
 * read at its target model. Bridge predicates compile to an over-fetch sentinel (`TRUE` / `{}`),
 * which is safe under AND / OR but not under the `NOT(if) OR then` of an implication — so an
 * implication that touches one over-fetches whole.
 */
export const conditionTouchesBridge = (
  condition: Condition,
  map: FieldMap | undefined,
  model: string | undefined,
): boolean =>
  !!map &&
  !!model &&
  someCondition<string>(
    condition,
    (node, at) =>
      typeof node.field === 'string' && node.field !== '' && hitsBridge(node.field, map, at),
    (node, at) =>
      (typeof node.field === 'string' ? relationTarget(node.field, map, at) : at) ?? false,
    model,
  );
