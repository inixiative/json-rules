import { resolveDateConfig } from '../date';
import type { ResolvedDateConfig } from '../dateExpr';
import { ruleShape } from '../fieldMap/shape';
import type { FieldMap } from '../fieldMap/types';
import { type Settle, settleLiteral } from '../negate';
import { ORDERED_OPERATORS } from '../operatorCatalog';
import { checkOnlyScopeRef, parseScopeRef, readContextRef } from '../scope';
import type { ValueSourceFields } from '../types';
import { compileBinding, matchSource, type ReadSource } from '../valueSource';
import type { PrismaBuildOptions } from './types';

/** A path on the Prisma rail: a context read. Prisma WHERE has no column-to-column comparison
 *  or arithmetic, so a row (`$.`) ref has no form here. */
const readPathValue = (ref: string, options?: PrismaBuildOptions): unknown => {
  const scoped = parseScopeRef(ref);
  if (scoped) {
    if (scoped.depth > 1) throw new Error(checkOnlyScopeRef(ref, 'toPrisma'));
    throw new Error(
      `Path '${ref}' is not supported by toPrisma(): Prisma WHERE has no column-to-column ` +
        `comparison or arithmetic. Use toSql() or prisma.$queryRaw.`,
    );
  }
  return readContextRef(ref, options?.context, 'toPrisma');
};

/** A value source on the Prisma rail: its value, a context read, or an unresolved bind. */
export const readSource = (
  source: ValueSourceFields<unknown>,
  options?: PrismaBuildOptions,
): unknown =>
  matchSource<unknown>(source, {
    value: (value) => value,
    path: (ref) => readPathValue(ref, options),
    bind: (name, optional) => compileBinding(name, optional, 'toPrisma'),
  });

export const prismaRead =
  (options?: PrismaBuildOptions): ReadSource =>
  (source) =>
    readSource(source, options);

export const dateConfigOf = (options?: PrismaBuildOptions): ResolvedDateConfig =>
  resolveDateConfig(
    { now: options?.now, timeZone: options?.timeZone, weekStart: options?.weekStart },
    prismaRead(options),
  );

/** A leaf with its value source and offset read as the Prisma rail reads them, for negation;
 *  null when one reads nothing (the leaf is then false). */
export const settleLeaf =
  (options?: PrismaBuildOptions): Settle =>
  (leaf) => {
    const comparison = typeof leaf.operator === 'string' || typeof leaf.dateOperator === 'string';
    const sourced =
      leaf.value !== undefined ||
      (typeof leaf.path === 'string' && leaf.path !== '') ||
      typeof leaf.bind === 'string';
    if (!comparison || 'aggregate' in leaf || !sourced) return leaf;
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
      throw new Error(
        `The complement of '${leaf.operator}' on the Json value '${leaf.field}' has no Prisma form (it keeps values of other types); use toSql() or check().`,
      );
    const value = readSource(leaf, options);
    const offset =
      leaf.offset === undefined ? undefined : readSource(leaf.offset as never, options);
    if (leaf.offset !== undefined && (offset === null || offset === undefined)) return null;
    const { path: _path, bind: _bind, bindOptional: _optional, ...rest } = leaf;
    const literal = {
      ...rest,
      value,
      ...(leaf.offset !== undefined && { offset: { value: offset } }),
    };
    if (typeof leaf.dateOperator === 'string')
      return value === null || value === undefined ? null : literal;
    return settleLiteral(literal);
  };
