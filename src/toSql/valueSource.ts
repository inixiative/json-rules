import { resolveDateConfig } from '../date';
import type { ResolvedDateConfig } from '../dateExpr';
import { checkOnlyScopeRef, parseScopeRef, readContextRef } from '../scope';
import type { FieldShape } from '../toPrisma/mapWalk';
import type { ValueSourceFields } from '../types';
import { compileBinding, matchSource, type ReadSource } from '../valueSource';
import { resolveField } from './join';
import type { BuilderState } from './types';

/**
 * An operand: a value bound as a parameter, or SQL evaluated per row. `computed` SQL is
 * arithmetic, whose NULL means "nothing to compare against" — never the is-null sentinel a
 * plain column comparison gets.
 */
export type ResolvedRhs =
  | { type: 'value'; value: unknown }
  | { type: 'column'; sql: string; shape?: FieldShape; computed?: true };

export const NO_VALUE: ResolvedRhs = { type: 'value', value: null };

export const isMissing = (rhs: ResolvedRhs): boolean =>
  rhs.type === 'value' && (rhs.value === null || rhs.value === undefined);

/** A ref on the SQL rail: `$.x` reads the current row the way a `field` does — relation hops
 *  join, a Json column's tail is a JSON path; a bare ref reads context. */
const resolveRef = (ref: string, state: BuilderState): ResolvedRhs => {
  const scoped = parseScopeRef(ref);
  if (scoped) {
    if (scoped.depth > 1) throw new Error(checkOnlyScopeRef(ref, 'toSql'));
    const column = resolveField(scoped.path, state);
    if (column.shape === 'relation')
      throw new Error(`'${ref}' is a relation; a value ref reads a column`);
    return { type: 'column', ...column };
  }
  return { type: 'value', value: readContextRef(ref, state.context, 'toSql') };
};

/** A value source on the SQL rail: a parameter, or a `$.` column. */
export const resolveSource = (
  source: ValueSourceFields<unknown>,
  state: BuilderState,
): ResolvedRhs =>
  matchSource<ResolvedRhs>(source, {
    value: (value) => ({ type: 'value', value }),
    path: (ref) => resolveRef(ref, state),
    bind: (name, optional) => ({ type: 'value', value: compileBinding(name, optional, 'toSql') }),
  });

/** Reads a source whose value is needed at compile time; a row ref here is a caller bug. */
export const compileTimeRead =
  (state: BuilderState): ReadSource =>
  (source) => {
    const resolved = resolveSource(source, state);
    if (resolved.type === 'column') throw new Error(`'${source.path}' is a row ref`);
    return resolved.value;
  };

export const dateConfigOf = (state: BuilderState): ResolvedDateConfig =>
  resolveDateConfig(state.dateConfig ?? {}, compileTimeRead(state));
