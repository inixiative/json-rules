import { FieldKind, NUMERIC_KINDS } from '../operatorCatalog';
import type { ValueType } from '../types';
import { refuse } from './valueTypeIssue';

export const NULL_TYPE: ValueType = { kind: null, isList: false, nullable: true };

const NO_ITEMS: ValueType = { kind: null, isList: false, nullable: false };

export const isNumeric = (kind: FieldKind | null): boolean =>
  kind !== null && NUMERIC_KINDS.includes(kind);

const describeType = (type: ValueType): string =>
  `${type.kind ?? 'null'}${type.isList ? '[]' : ''}`;

/** One type both of two values fit: null fits any; two numeric kinds read as Decimal when either
 *  is Decimal (it holds the other exactly), else as Float. */
export const unify = (a: ValueType, b: ValueType, path: string): ValueType => {
  const nullable = a.nullable || b.nullable;
  if (a.kind === null && a.isList === b.isList) return { ...b, nullable };
  if (b.kind === null && a.isList === b.isList) return { ...a, nullable };
  if (a.kind === null && !a.isList) return { ...b, nullable: true };
  if (b.kind === null && !b.isList) return { ...a, nullable: true };
  if (a.isList === b.isList) {
    if (a.kind === b.kind) return { ...a, nullable };
    if (isNumeric(a.kind) && isNumeric(b.kind)) {
      const isDecimal = a.kind === FieldKind.Decimal || b.kind === FieldKind.Decimal;
      return { kind: isDecimal ? FieldKind.Decimal : FieldKind.Float, isList: a.isList, nullable };
    }
  }
  return refuse(
    path,
    'value_type_mismatch',
    `the values here are ${describeType(a)} and ${describeType(b)}`,
  );
};

/** A list of items of these types: their one kind, as a list. */
export const listType = (items: ValueType[], path: string): ValueType => ({
  ...items.reduce<ValueType>((acc, item) => unify(acc, item, path), NO_ITEMS),
  isList: true,
});
