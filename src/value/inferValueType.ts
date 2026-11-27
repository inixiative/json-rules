import { isDateExpr, rollingShift } from '../dateExpr';
import { invalidValueExpression } from '../errors';
import type { Lens, LensNarrowing } from '../lens/types';
import { FieldKind, isCalendarUnit, NUMERIC_KINDS, ORDERED_VALUE_KINDS } from '../operatorCatalog';
import { isCoercedLiteral, listItems, valueExpressionShape } from '../traverse';
import type {
  AggregateValue,
  CoercedLiteral,
  DateExpr,
  IfThenElseValue,
  ValueExpression,
  ValueType,
} from '../types';
import { hasPath, isValueSource } from '../valueSource';
import { aggregateType, coerceMismatch, coerces } from './aggregateType';
import { isDistinct } from './distinctValues';
import { literalType } from './literalType';
import { pathType } from './pathType';
import { needLens } from './resolveValuePath';
import { listType, NULL_TYPE, unify } from './unifyValueTypes';
import { assertValidValue } from './validateValue';
import { refuse } from './valueTypeIssue';

type Lensish = Lens | LensNarrowing | undefined;

const WHOLE_KINDS: readonly FieldKind[] = [FieldKind.Int, FieldKind.BigInt];

const isNumericKind = (kind: FieldKind | null): boolean =>
  kind !== null && NUMERIC_KINDS.includes(kind);

const isDateOffsetBase = (kind: FieldKind | null): boolean =>
  kind === null || kind === FieldKind.Json || ORDERED_VALUE_KINDS.includes(kind);

const dateExprType = (expr: DateExpr, lens: Lensish, path: string): ValueType => {
  let nullable = false;
  const rolling = rollingShift(expr);
  if (rolling) {
    const key = Object.keys(expr)[0];
    for (const [unit, amount] of Object.entries(rolling[0])) {
      if (!isValueSource(amount)) continue;
      const at = `${path}.${key}.${unit}`;
      if (hasPath(amount)) {
        const kind = pathType(needLens(lens, `the path '${amount.path}'`), amount.path, at);
        if (kind.isList)
          refuse(
            at,
            'invalid_relative_magnitude',
            `'${amount.path}' (${unit}) reads a scalar number, not a list`,
          );
        if (kind.kind !== null && kind.kind !== FieldKind.Json) {
          const allowed = isCalendarUnit(unit) ? WHOLE_KINDS : NUMERIC_KINDS;
          if (!allowed.includes(kind.kind))
            refuse(
              at,
              'invalid_relative_magnitude',
              `'${amount.path}' (${unit}) needs a ${isCalendarUnit(unit) ? 'whole-number' : 'numeric'} field, got ${kind.kind}`,
            );
        }
        nullable = true;
      } else if ('bind' in amount) {
        nullable = true;
      } else if (amount.value === null) {
        nullable = true;
      }
    }
  }
  return { kind: FieldKind.DateTime, isList: false, nullable };
};

// A literal typed as its coerceType, refused when that kind can't read what is written.
const coercedLiteralType = (node: CoercedLiteral, path: string): ValueType => {
  const written = literalType(node.value, `${path}.value`);
  if (!coerces(written.kind, node.coerceType))
    refuse(
      `${path}.coerceType`,
      'coerce_kind_mismatch',
      coerceMismatch(written.kind, node.coerceType),
    );
  return { ...written, kind: node.coerceType };
};

const offsetType = (
  base: ValueType,
  offset: Record<string, unknown>,
  lens: Lensish,
  path: string,
): ValueType => {
  const at = `${path}.offset`;
  const isLiteralDateShift = Object.hasOwn(offset, 'value') && isDateExpr(offset.value);
  const shift = isLiteralDateShift
    ? dateExprType(offset.value as DateExpr, lens, `${at}.value`)
    : sourceType(offset, lens, at);
  const nullable = base.nullable || shift.nullable;

  if (shift.isList)
    refuse(at, 'offset_kind_mismatch', 'an offset reads a single value, not a list');

  if (isLiteralDateShift) {
    if (base.isList || !isDateOffsetBase(base.kind))
      refuse(
        path,
        'offset_kind_mismatch',
        `a date offset requires a date-like base, not ${base.isList ? 'a list' : String(base.kind)}`,
      );
    return { kind: FieldKind.DateTime, isList: false, nullable };
  }

  if (base.kind === FieldKind.DateTime) {
    if (shift.kind !== FieldKind.Json)
      refuse(
        at,
        'offset_kind_mismatch',
        `a date base requires a date offset ({ ago } / { ahead } or Json), not ${String(shift.kind)}`,
      );
    if (base.isList)
      refuse(path, 'offset_kind_mismatch', 'a date offset requires a single date, not a list');
    return { kind: FieldKind.DateTime, isList: false, nullable };
  }

  if (base.kind !== null && base.kind !== FieldKind.Json && !isNumericKind(base.kind))
    refuse(
      path,
      'offset_kind_mismatch',
      `a numeric offset requires a numeric base, not ${base.kind}`,
    );
  if (shift.kind !== null && shift.kind !== FieldKind.Json && !isNumericKind(shift.kind))
    refuse(
      at,
      'offset_kind_mismatch',
      `a numeric offset requires a numeric shift, not ${shift.kind}`,
    );

  const kind =
    base.kind === FieldKind.Decimal || shift.kind === FieldKind.Decimal
      ? FieldKind.Decimal
      : base.kind === FieldKind.Int && shift.kind === FieldKind.Int
        ? FieldKind.Int
        : FieldKind.Float;
  return { kind, isList: base.isList, nullable };
};

const sourceType = (node: Record<string, unknown>, lens: Lensish, path: string): ValueType => {
  let base: ValueType;
  if (isCoercedLiteral(node)) base = coercedLiteralType(node, path);
  else if (node.value !== undefined)
    base =
      node.offset !== undefined && isDateExpr(node.value)
        ? dateExprType(node.value, lens, `${path}.value`)
        : literalType(node.value, `${path}.value`);
  else if (typeof node.bind === 'string')
    return refuse(
      path,
      'untyped_binding',
      `{ bind: '${node.bind}' } has no type until it is bound`,
    );
  else
    base = pathType(needLens(lens, `the path '${String(node.path)}'`), node.path as string, path);

  if (node.offset === undefined) return base;
  return offsetType(base, node.offset as Record<string, unknown>, lens, path);
};

// In a list a missed `if` adds nothing; anywhere else it is null.
const ifType = (node: IfThenElseValue, lens: Lensish, path: string, inList: boolean): ValueType => {
  const then = inferAt(node.then, lens, `${path}.then`, inList);
  if (node.else === undefined) return inList ? then : unify(then, NULL_TYPE, path);
  return unify(then, inferAt(node.else, lens, `${path}.else`, inList), path);
};

const listOf = (expr: unknown, lens: Lensish, path: string): ValueType => {
  const type = listType(
    listItems(expr).map((item, index) => {
      const at = `${path}[${index}]`;
      const itemType = inferAt(item, lens, at, true);
      if (itemType.isList) refuse(at, 'nested_list', "a list's items are single values");
      return itemType;
    }),
    path,
  );
  if (isDistinct(expr) && type.kind === FieldKind.Json)
    refuse(`${path}.distinct`, 'distinct_over_json', 'distinct drops repeated values, not Json');
  return type;
};

const inferAt = (expr: unknown, lens: Lensish, path: string, inList: boolean): ValueType => {
  switch (valueExpressionShape(expr)) {
    case 'literal':
      return literalType(expr, path);
    case 'date':
      return dateExprType(expr as DateExpr, lens, path);
    case 'source':
      return sourceType(expr as Record<string, unknown>, lens, path);
    case 'aggregate':
      return aggregateType(lens, expr as AggregateValue, path);
    case 'if':
      return ifType(expr as IfThenElseValue, lens, path, inList);
    case 'list':
      return listOf(expr, lens, path);
    default:
      return refuse(path, 'invalid_value_expression', invalidValueExpression(path).message);
  }
};

/**
 * The type a value expression returns, worked out without data — for a consumer to check against
 * the type it stores before saving the expression. A literal, bare or `{ value }`, has its value's
 * kind (a whole number `Int`, any other `Float`); a date expression `DateTime`; a path its column's
 * kind through the lens (nullable unless the map declares it required); `count` an `Int`; `sum`
 * its column's numeric kind, never null (0 over no rows); `avg` a `Float` (`Decimal` stays
 * `Decimal`), null over no rows; `min` / `max` their column's kind, nullable (no rows). An `if`'s
 * branches and a list's items must agree (two numeric kinds read as `Decimal` when either is, else
 * `Float`; a missing `else` is null). `lens` is needed wherever a path's kind is read. Throws on
 * an expression that has no type: a path that does not resolve, reads through a to-many relation
 * or names rows, an aggregate over something that isn't a list, branches that disagree, a binding,
 * `distinct` over Json.
 */
export const inferValueType = (
  expression: ValueExpression,
  lens?: Lens | LensNarrowing,
): ValueType => {
  assertValidValue(expression);
  return inferAt(expression, lens, '$', false);
};
