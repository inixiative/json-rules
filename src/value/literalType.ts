import { FieldKind } from '../operatorCatalog';
import type { ValueType } from '../types';
import { listType, NULL_TYPE } from './unifyValueTypes';
import { refuse } from './valueTypeIssue';

/** A literal's type: a whole number `Int`, any other `Float`; a bare array a list of its items. */
export const literalType = (value: unknown, path: string): ValueType => {
  if (value === null) return NULL_TYPE;
  if (typeof value === 'number')
    return {
      kind: Number.isInteger(value) ? FieldKind.Int : FieldKind.Float,
      isList: false,
      nullable: false,
    };
  if (typeof value === 'bigint') return { kind: FieldKind.BigInt, isList: false, nullable: false };
  if (typeof value === 'string') return { kind: FieldKind.String, isList: false, nullable: false };
  if (typeof value === 'boolean')
    return { kind: FieldKind.Boolean, isList: false, nullable: false };
  if (value instanceof Date) return { kind: FieldKind.DateTime, isList: false, nullable: false };
  if (Array.isArray(value))
    return listType(
      value.map((item, index) => {
        const at = `${path}[${index}]`;
        if (Array.isArray(item)) refuse(at, 'nested_list', "a list's items are single values");
        return literalType(item, at);
      }),
      path,
    );
  return { kind: FieldKind.Json, isList: false, nullable: false };
};
