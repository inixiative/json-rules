import { applyCoercion } from './field';
import { entryKind } from './fieldMap/shape';
import type { MapWalkResult } from './fieldMap/walk';
import { COMPILE_COERCED_KINDS, FieldKind, NUMERIC_KINDS } from './operatorCatalog';
import type { Rule } from './types';

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
  // boolean column, nor a number or boolean a String one; the compilers would cast it. Refuse it —
  // stamp `coerceType` to compare it.
  if (
    rule.coerceType === undefined &&
    declared === FieldKind.String &&
    (Array.isArray(value) ? value : [value]).some(
      (item) => typeof item === 'number' || typeof item === 'boolean',
    )
  )
    throw new Error(
      `'${rule.field}' is String but the literal is not a string; pass a string, or stamp coerceType: 'String'.`,
    );
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
