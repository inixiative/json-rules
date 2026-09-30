import { isDateInputValue, parseDateValue } from '../date';
import { applyCoercion } from '../field';
import {
  type CatalogEntry,
  DATE_OPERATOR_CATALOG,
  FIELD_OPERATOR_CATALOG,
  FieldKind,
} from '../operatorCatalog';
import { own } from '../own';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { DateRule, Rule } from '../types';
import type { RuleLensViolation } from './checkRule.ts';
import { isJsonEntry } from './walk.ts';

/** The kind a declared field compares as — undefined where the map does not pin one down:
 *  relations, Json (open-ended), scalar lists, and scalar types outside FieldKind. */
export const entryKind = (entry: FieldMapEntry): FieldKind | undefined => {
  if (entry.isList) return undefined;
  if (entry.kind === 'enum') return FieldKind.Enum;
  if (entry.kind !== 'scalar' || entry.type === FieldKind.Json) return undefined;
  return Object.hasOwn(FieldKind, entry.type) ? (entry.type as FieldKind) : undefined;
};

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

const isDate = (v: unknown): boolean => isDateInputValue(v) && parseDateValue(v, 'UTC').isValid();

// What a literal must be to compare against a column of each kind — the values every rail
// accepts. Json and Bytes carry no value-taking operator the catalog allows, so any passes.
const LITERAL_FIT: Record<FieldKind, { expected: string; fits: (v: unknown) => boolean }> = {
  String: { expected: 'a string', fits: (v) => typeof v === 'string' },
  Enum: { expected: 'a string', fits: (v) => typeof v === 'string' },
  Int: { expected: 'an integer', fits: Number.isInteger },
  BigInt: { expected: 'an integer', fits: (v) => Number.isInteger(v) || typeof v === 'bigint' },
  Float: { expected: 'a number', fits: Number.isFinite },
  Decimal: { expected: 'a number', fits: Number.isFinite },
  Boolean: { expected: 'a boolean', fits: (v) => typeof v === 'boolean' },
  DateTime: { expected: 'a date', fits: isDate },
  Json: { expected: 'a value', fits: () => true },
  Bytes: { expected: 'a value', fits: () => true },
};

const show = (v: unknown): string =>
  typeof v === 'string' ? `'${v}'` : typeof v === 'bigint' ? `${v}n` : JSON.stringify(v);

/**
 * Operator ⇄ kind, then literal ⇄ kind, for a field or date leaf. The kind is the rule's
 * `coerceType` when set, else the declared entry's; unknown means nothing to gate. A literal
 * is coerced first (check()'s own coercion) only when `coerceType` OVERRIDES the declared kind:
 * a stamp equal to the column's kind adds no information, and the compilers do not coerce
 * literals, so the raw literal must already fit.
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

  // Date-rule values are validateRule's (grammar-level, kind-independent); a regex pattern is
  // not a column value.
  if ('dateOperator' in cond || entry.valueShape === 'none' || entry.valueShape === 'pattern')
    return [];

  const { expected, fits } = LITERAL_FIT[kind];
  return (ruleLiterals(cond) ?? [])
    .filter((v) => v !== null && !fits(coerced ? applyCoercion(v, kind) : v))
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
  const single =
    entry.kind === 'object' || entry.kind === 'bridge'
      ? 'a to-one relation'
      : `a single ${entryKind(entry) ?? entry.type} value`;
  return {
    path: field,
    reason: `arrayOperator '${arrayOperator}' needs a list, but '${field}' is ${single}`,
  };
};
