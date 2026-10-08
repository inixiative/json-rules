import { resolveDateConfig } from '../date';
import type { ResolvedDateConfig } from '../dateExpr';
import { noCompiledForm } from '../errors';
import { hasNoOperand } from '../field';
import { ruleShape } from '../fieldMap/shape';
import type { FieldMap } from '../fieldMap/types';
import { type Settle, settleLiteral } from '../negate';
import { ORDERED_OPERATORS } from '../operatorCatalog';
import { checkOnlyScopeRef, parseScopeRef } from '../scope';
import type { Rule, ValueSourceFields } from '../types';
import { compileBinding, matchSource, type ReadSource } from '../valueSource';
import { holdsReservedKey } from './sentinels';
import type { ToPrismaOptions } from './types';

/** A path reads a column, bare (the root row) or `$.`: Prisma WHERE has no general
 *  column-to-column comparison or arithmetic, so it has no form here. */
const readPathValue = (ref: string): never => {
  const scoped = parseScopeRef(ref);
  if (scoped && scoped.depth > 1) throw new Error(checkOnlyScopeRef(ref, 'toPrisma'));
  throw new Error(
    `Path '${ref}' compares to a column, which isn't supported on the Prisma rail; use toSql() or check().`,
  );
};

/** A value source on the Prisma rail: its value, or an unresolved bind. */
export const readSource = (source: ValueSourceFields<unknown>): unknown =>
  matchSource<unknown>(source, {
    value: (value) => {
      if (holdsReservedKey(value))
        throw new Error(
          `toPrisma: a value holding a '__step' or '__field' key is reserved for the plan's own references`,
        );
      return value;
    },
    path: (ref) => readPathValue(ref),
    bind: (name, optional) => compileBinding(name, optional, 'toPrisma'),
  });

export const prismaRead: ReadSource = (source) => readSource(source);

export const dateConfigOf = (options?: ToPrismaOptions): ResolvedDateConfig =>
  resolveDateConfig(
    { now: options?.now, timeZone: options?.timeZone, weekStart: options?.weekStart },
    prismaRead,
  );

/** A leaf with its value source and offset read as the Prisma rail reads them, for negation;
 *  null when one reads nothing (the leaf is then false). */
export const settleLeaf =
  (options?: ToPrismaOptions): Settle =>
  (leaf) => {
    const comparison = typeof leaf.operator === 'string' || typeof leaf.dateOperator === 'string';
    const sourced =
      leaf.value !== undefined ||
      (typeof leaf.path === 'string' && leaf.path !== '') ||
      typeof leaf.bind === 'string';
    if (!comparison || 'aggregate' in leaf || !sourced) return leaf;
    // A column compared with a column stays one: its complement compiles to a field reference.
    if (typeof leaf.operator === 'string' && typeof leaf.path === 'string' && leaf.path !== '')
      return leaf;
    // The complement of an ordered comparison keeps the values of other types, which Prisma's
    // Json filters can't test for.
    const shape = ruleShape(
      { field: String(leaf.field) },
      options?.map as FieldMap | undefined,
      options?.model,
    );
    if (
      (shape === 'json' || shape === 'json-path') &&
      typeof leaf.operator === 'string' &&
      ORDERED_OPERATORS.includes(leaf.operator)
    )
      throw noCompiledForm(
        'toPrisma',
        `The complement of '${leaf.operator}' on the Json value '${leaf.field}'`,
        'it keeps values of other types',
      );
    const value = readSource(leaf);
    const offset = leaf.offset === undefined ? undefined : readSource(leaf.offset as never);
    if (leaf.offset !== undefined && (offset === null || offset === undefined)) return null;
    const { path: _path, bind: _bind, bindOptional: _optional, ...rest } = leaf;
    const literal = {
      ...rest,
      value,
      ...(leaf.offset !== undefined && { offset: { value: offset } }),
    };
    // A date range with a missing end reads nothing, as a field range does.
    if (typeof leaf.dateOperator === 'string')
      return value === null ||
        value === undefined ||
        hasNoOperand({ operator: leaf.dateOperator } as Rule, value)
        ? null
        : literal;
    return settleLiteral(literal);
  };
