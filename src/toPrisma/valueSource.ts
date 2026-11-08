import { resolveDateConfig } from '../date';
import type { ResolvedDateConfig } from '../dateExpr';
import { noCompiledForm } from '../errors';
import { ruleShape } from '../fieldMap/shape';
import type { FieldMap } from '../fieldMap/types';
import { type Settle, settleWith } from '../negate';
import { ORDERED_OPERATORS } from '../operatorCatalog';
import { checkOnlyScopeRef, parseScopeRef } from '../scope';
import type { ValueSourceFields } from '../types';
import { compileBinding, hasPath, matchSource, type ReadSource } from '../valueSource';
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
export const settleLeaf = (options?: ToPrismaOptions): Settle => {
  const settle = settleWith((source) => readSource(source));
  return (leaf, depth) => {
    // A column compared with a column stays one: its complement compiles to a field reference.
    if (typeof leaf.operator === 'string' && hasPath(leaf as ValueSourceFields<unknown>))
      return leaf;
    // The complement of an ordered comparison keeps the values of other types, which Prisma's
    // Json filters can't test for.
    const sourced = leaf.value !== undefined || typeof leaf.bind === 'string';
    if (
      sourced &&
      !('aggregate' in leaf) &&
      typeof leaf.operator === 'string' &&
      ORDERED_OPERATORS.includes(leaf.operator)
    ) {
      const shape = ruleShape(
        { field: String(leaf.field) },
        options?.map as FieldMap | undefined,
        options?.model,
      );
      if (shape === 'json' || shape === 'json-path')
        throw noCompiledForm(
          'toPrisma',
          `The complement of '${leaf.operator}' on the Json value '${leaf.field}'`,
          'it keeps values of other types',
        );
    }
    return settle(leaf, depth);
  };
};
