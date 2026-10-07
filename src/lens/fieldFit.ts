import { applyCoercion } from '../field';
import {
  type CatalogEntry,
  DATE_OPERATOR_CATALOG,
  FIELD_OPERATOR_CATALOG,
  FieldKind,
  NUMERIC_KINDS,
  SINGLE_VALUE_SHAPES,
} from '../operatorCatalog';
import { own } from '../own';
import { entryKind, instantMs } from '../toPrisma/mapWalk';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { DateRule, Rule } from '../types';
import type { RuleLensViolation } from './checkRule.ts';
import { isJsonEntry } from './walk.ts';

/** A leaf's literal operands — the elements for in/notIn/between. Null when the comparison
 *  value is a `path` ref or a `bind` token: a runtime value, unknown at gate time. */
export const ruleLiterals = (cond: {
  value?: unknown;
  path?: unknown;
}): readonly unknown[] | null => {
  if (cond.path !== undefined) return null;
  const v = cond.value;
  if (v === undefined) return null;
  if (Array.isArray(v)) return v;
  return [v];
};

// A date the compilers can turn into an instant — the seam compileFieldLiteral emits from, so the
// gate accepts exactly what compiles.
const isDate = (v: unknown): boolean => instantMs(v) !== undefined;

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

// What a literal must be to compare against a column of each kind — JSON values only, the
// ones every rail accepts. Json and Bytes carry no value-taking
// operator the catalog allows, so any passes.
const LITERAL_FIT: Record<FieldKind, { expected: string; fits: (v: unknown) => boolean }> = {
  String: { expected: 'a string', fits: (v) => typeof v === 'string' },
  Enum: { expected: 'a string', fits: (v) => typeof v === 'string' },
  Int: { expected: 'an integer', fits: Number.isSafeInteger },
  // BigInt compares as Int; a stamped digit string fits after coercion, like any Int literal.
  BigInt: { expected: 'an integer', fits: Number.isSafeInteger },
  Float: { expected: 'a number', fits: Number.isFinite },
  // A numeric string is the lossless JSON spelling of a Decimal (what a builder keeps, since
  // Number() would round it); Prisma and Postgres take it as written.
  Decimal: {
    expected: 'a number or a numeric string',
    fits: (v) => Number.isFinite(v) || (typeof v === 'string' && NUMERIC_STRING.test(v)),
  },
  Boolean: { expected: 'a boolean', fits: (v) => typeof v === 'boolean' },
  DateTime: { expected: 'a date', fits: isDate },
  Json: { expected: 'a value', fits: () => true },
  Bytes: { expected: 'a value', fits: () => true },
};

const show = (v: unknown): string =>
  typeof v === 'string'
    ? `'${v}'`
    : typeof v === 'object' && v !== null
      ? JSON.stringify(v)
      : String(v);

// Operators that compare one value: a list literal is a value no rail can compare.

/**
 * Operator ⇄ kind, then literal ⇄ kind, for a field or date leaf. The kind is the rule's
 * `coerceType` when set, else the declared entry's; unknown means nothing to gate. With a
 * `coerceType` the literal fits as written or after check()'s own coercion — the coercion
 * compileFieldLiteral applies too, so every rail compares the same value.
 */
export const leafFitViolations = (
  cond: Rule | DateRule,
  declared: FieldKind | undefined,
): RuleLensViolation[] => {
  const coerceType = 'coerceType' in cond ? cond.coerceType : undefined;
  const kind = coerceType ?? declared;
  if (kind === undefined || kind === FieldKind.Json) return [];

  const op = 'operator' in cond ? cond.operator : cond.dateOperator;
  const entry: CatalogEntry | undefined =
    'operator' in cond ? own(FIELD_OPERATOR_CATALOG, op) : own(DATE_OPERATOR_CATALOG, op);
  if (!entry) return [];

  const coerced = coerceType !== undefined && coerceType !== declared;
  const label = coerced
    ? `field '${cond.field}' coerced to ${kind}`
    : `${kind} field '${cond.field}'`;

  if (!entry.kinds.includes(kind)) {
    return [
      {
        path: cond.field,
        reason: `operator '${op}' does not apply to ${label} (applies to: ${entry.kinds.join(', ')})`,
      },
    ];
  }

  // An offset is arithmetic on the field's kind: a number on a numeric field, a rolling shift
  // on a DateTime.
  if (cond.offset !== undefined) {
    const shiftable =
      'dateOperator' in cond ? kind === FieldKind.DateTime : NUMERIC_KINDS.includes(kind);
    if (!shiftable) return [{ path: cond.field, reason: `an offset does not apply to ${label}` }];
  }

  // Date-rule values are validateRule's (grammar-level, kind-independent); a regex pattern is
  // not a column value.
  if ('dateOperator' in cond || entry.valueShape === 'none' || entry.valueShape === 'pattern')
    return [];

  if (SINGLE_VALUE_SHAPES.includes(entry.valueShape) && Array.isArray(cond.value)) {
    return [
      {
        path: cond.field,
        reason: `operator '${op}' compares one value, but ${label} was given a list`,
      },
    ];
  }

  const { expected, fits } = LITERAL_FIT[kind];
  // A coercion that refuses its input (a BigInt past ±2^53) is a misfit, reported — never thrown.
  const coercedFits = (v: unknown): boolean => {
    try {
      return fits(applyCoercion(v, kind));
    } catch {
      return false;
    }
  };
  const fitsAsCompiled = (v: unknown): boolean =>
    fits(v) || (coerceType !== undefined && coercedFits(v));
  return (ruleLiterals(cond) ?? [])
    .filter((v) => v !== null && !fitsAsCompiled(v))
    .map((v) => ({
      path: cond.field,
      reason: `value ${show(v)} does not fit ${label} (expected ${expected})`,
    }));
};

/** An array operator iterates its field, so the field must be a list: a to-many relation or
 *  bridge, a scalar list, or a Json column (elements undeclared). */
export const arrayFitViolation = (
  field: string,
  arrayOperator: string,
  entry: FieldMapEntry,
): RuleLensViolation | null => {
  if (entry.isList === true || isJsonEntry(entry)) return null;
  const reason =
    entry.kind === 'object' || entry.kind === 'bridge'
      ? `arrayOperator '${arrayOperator}' needs a list, but '${field}' is a to-one relation — a single related record; address its fields directly (e.g. '${field}.<field>')`
      : `arrayOperator '${arrayOperator}' needs a list, but '${field}' is a single ${entryKind(entry) ?? entry.type} value`;
  return { path: field, reason };
};
