import { applyCoercion } from '../field';
import { FieldKind } from '../operatorCatalog';
import { own } from '../own';
import type { Rule } from '../types';
import type { FieldMap, FieldMapEntry } from './types';

export type MapWalkResult =
  | { kind: 'direct'; entry?: FieldMapEntry }
  | { kind: 'json-path'; stopIndex: number; jsonPath: string[] }
  | { kind: 'bridge' }
  | { kind: 'fallback' };

/**
 * Walk a dot-notation field path through the FieldMap.
 *
 * Returns how to interpret the path:
 * - 'direct'    – all segments are relations/scalars, use standard nested filter;
 *                 `entry` is the terminal field's map entry
 * - 'json-path' – a Json scalar was found mid-path; stopIndex segments form the
 *                 Prisma nested key, the rest become the JSON path array
 * - 'fallback'  – a segment was not found in the map; use existing behavior
 */
/**
 * The dotted prefixes of `field` that end on an OPTIONAL to-one relation (`kind: 'object'`,
 * not a list, `isRequired: false`), outermost first — every hop at which the path can be
 * absent as a whole. A required hop, a list hop, an unmapped segment, or the terminal
 * segment contributes nothing. Same licensing authority as isRequired on a column.
 */
export const optionalToOneHops = (field: string, map: FieldMap, rootModel: string): string[] => {
  const parts = field.split('.');
  const hops: string[] = [];
  let currentModel = rootModel;
  for (let i = 0; i < parts.length - 1; i++) {
    const modelEntry = map.models[currentModel];
    if (!modelEntry) return hops;
    const fieldEntry = own(modelEntry.fields, parts[i]);
    if (fieldEntry?.kind !== 'object' || !map.models[fieldEntry.type]) return hops;
    if (!fieldEntry.isList && fieldEntry.isRequired === false)
      hops.push(parts.slice(0, i + 1).join('.'));
    currentModel = fieldEntry.type;
  }
  return hops;
};

export const walkFieldPath = (field: string, map: FieldMap, rootModel: string): MapWalkResult => {
  const parts = field.split('.');
  let currentModel = rootModel;

  for (let i = 0; i < parts.length; i++) {
    const modelEntry = map.models[currentModel];
    if (!modelEntry) return { kind: 'fallback' };

    const fieldEntry = own(modelEntry.fields, parts[i]);
    if (!fieldEntry) return { kind: 'fallback' };

    if (fieldEntry.kind === 'bridge') return { kind: 'bridge' };

    if (fieldEntry.kind === 'scalar' && fieldEntry.type === 'Json' && i < parts.length - 1) {
      // This segment is a Json field and there are more segments → JSON path
      return { kind: 'json-path', stopIndex: i + 1, jsonPath: parts.slice(i + 1) };
    }

    if (fieldEntry.kind === 'object') {
      if (!map.models[fieldEntry.type]) return { kind: 'fallback' };
      if (i === parts.length - 1) return { kind: 'direct', entry: fieldEntry };
      currentModel = fieldEntry.type;
      continue;
    }

    // scalar or enum at a terminal position
    return { kind: 'direct', entry: fieldEntry };
  }

  return { kind: 'direct' };
};

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
export const instantMs = (value: unknown): number | undefined => {
  const ms = applyCoercion(value, FieldKind.DateTime);
  return typeof ms === 'number' && !Number.isNaN(new Date(ms).getTime()) ? ms : undefined;
};

// Prisma takes a Date. toSql takes the zoned ISO string: a pg driver serializes a Date param in
// the HOST's zone, which a `timestamp` (no time zone) column — Prisma's Postgres default —
// silently drops; a `...Z` string casts to the same instant on either column type.
const toInstant =
  (field: string, target: CompileTarget) =>
  (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    const ms = instantMs(value);
    if (ms === undefined)
      throw new Error(`Invalid date value for DateTime field '${field}': ${String(value)}`);
    return target === 'toPrisma' ? new Date(ms) : new Date(ms).toISOString();
  };

type CompileTarget = 'toPrisma' | 'toSql';

// Kinds whose stamped literal the compilers coerce exactly as check() does — Prisma rejects a
// string on these. Decimal and BigInt keep their literal: Prisma and Postgres take the numeric
// string losslessly, and coercing it to a JS number would not be.
const COMPILE_COERCED: ReadonlySet<FieldKind> = new Set([
  FieldKind.Int,
  FieldKind.Float,
  FieldKind.Boolean,
  FieldKind.String,
]);

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
    const instant = toInstant(rule.field, target);
    return Array.isArray(value) ? value.map(instant) : instant(value);
  }
  return rule.coerceType !== undefined && COMPILE_COERCED.has(rule.coerceType)
    ? applyCoercion(value, rule.coerceType)
    : value;
};
