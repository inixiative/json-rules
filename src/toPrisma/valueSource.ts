import { resolveDateConfig } from '../date';
import type { ResolvedDateConfig } from '../dateExpr';
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
