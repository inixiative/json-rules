import { get } from 'lodash-es';
import { checkOnlyScopeRef, parseScopeRef } from '../scope';
import type { ReadRef } from '../valueSource';
import type { BuildOptions } from './types';

/** A `path` comparison value: a context read. Prisma WHERE has no column-to-column comparison. */
export const readPathValue = (ref: string, options?: BuildOptions): unknown => {
  const scoped = parseScopeRef(ref);
  if (scoped) {
    if (scoped.depth > 1) throw new Error(checkOnlyScopeRef(ref, 'toPrisma'));
    throw new Error(
      `Prisma WHERE has no column-to-column comparison for path '${ref}'. ` +
        `Use prisma.$queryRaw for field-to-field filtering.`,
    );
  }
  if (!options?.context) {
    throw new Error(
      `options.context is required to resolve path '${ref}'. Pass context when calling toPrisma().`,
    );
  }
  return get(options.context, ref);
};

/** Reads an offset or magnitude `{ path }`: context only — Prisma WHERE has no arithmetic. */
export const amountReader =
  (options?: BuildOptions): ReadRef =>
  (ref) => {
    if (parseScopeRef(ref))
      throw new Error(
        `Row ref '${ref}' in an offset or magnitude is not supported by toPrisma(); ` +
          `evaluate with check() or compile with toSql()`,
      );
    return readPathValue(ref, options);
  };
