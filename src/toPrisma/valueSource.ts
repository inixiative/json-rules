import { resolveDateConfig } from '../date';
import type { ResolvedDateConfig } from '../dateExpr';
import { type Settle, settleLiteral } from '../negate';
import { checkOnlyScopeRef, parseScopeRef, readContextRef } from '../scope';
import type { ValueSourceFields } from '../types';
import { compileBinding, matchSource, type ReadSource } from '../valueSource';
import type { BuildOptions } from './types';

/** A path on the Prisma rail: a context read. Prisma WHERE has no column-to-column comparison
 *  or arithmetic, so a row (`$.`) ref has no form here. */
const readPathValue = (ref: string, options?: BuildOptions): unknown => {
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
export const readSource = (source: ValueSourceFields<unknown>, options?: BuildOptions): unknown =>
  matchSource<unknown>(source, {
    value: (value) => value,
    path: (ref) => readPathValue(ref, options),
    bind: (name, optional) => compileBinding(name, optional, 'toPrisma'),
  });

export const prismaRead =
  (options?: BuildOptions): ReadSource =>
  (source) =>
    readSource(source, options);

export const dateConfigOf = (options?: BuildOptions): ResolvedDateConfig =>
  resolveDateConfig(
    { now: options?.now, timeZone: options?.timeZone, weekStart: options?.weekStart },
    prismaRead(options),
  );

/** A leaf with its value source and offset read as the Prisma rail reads them, for negation;
 *  null when one reads nothing (the leaf is then false). */
export const settleLeaf =
  (options?: BuildOptions): Settle =>
  (leaf) => {
    const comparison = typeof leaf.operator === 'string' || typeof leaf.dateOperator === 'string';
    const sourced =
      leaf.value !== undefined ||
      (typeof leaf.path === 'string' && leaf.path !== '') ||
      typeof leaf.bind === 'string';
    if (!comparison || 'aggregate' in leaf || !sourced) return leaf;
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
