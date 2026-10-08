import { isPlainObject } from 'lodash-es';
import { UsageError } from './errors';
import { parseScopeRef, readPath, type ScopeRef, type Scopes } from './scope';
import type { RuleValue, ValueSourceFields, ValueSourceOf } from './types';

// A value source is `{ value } | { path } | { bind }`. One dispatch reads it; each rail supplies
// only what a path and a bind mean there. Its consumers — a leaf's comparison value, an offset,
// a unit amount, the evaluation's time zone — decide what the value means.

type Source = ValueSourceFields<unknown>;

/** The three forms, in the order a source is read. */
export const SOURCE_FORMS = ['value', 'bind', 'path'] as const;

/** A non-empty `path` — the one test for "reads a path". */
export const hasPath = (source: Source): source is Source & { path: string } =>
  typeof source.path === 'string' && source.path !== '';

/** The scope a source's path reads — every path reads the row: `$.`, `$$.`, … by depth, and a
 *  bare path the root row (depth 0). Null when the source reads no path. */
export const rowRef = (source: Source): ScopeRef | null =>
  hasPath(source) ? (parseScopeRef(source.path) ?? { depth: 0, path: source.path }) : null;

type SourceReaders<R> = {
  value: (value: unknown) => R;
  path: (ref: string) => R;
  bind: (name: string, optional: boolean | undefined) => R;
};

/** The one dispatch over a value source's three forms. */
export const matchSource = <R>(source: Source, read: SourceReaders<R>): R => {
  if (source.value !== undefined) return read.value(source.value);
  if (source.bind !== undefined) return read.bind(source.bind, source.bindOptional);
  if (hasPath(source)) return read.path(source.path);
  throw new Error('No value, path or bind specified');
};

export const isValueSource = (v: unknown): v is ValueSourceOf<unknown> =>
  isPlainObject(v) &&
  ((v as Source).value !== undefined ||
    hasPath(v as Source) ||
    typeof (v as Source).bind === 'string');

/**
 * The value of one `{ bind }` at evaluation. Key presence is the contract: an unsupplied
 * binding is a caller bug (a forgotten scope must never silently run) unless the source marks
 * it `bindOptional`, which reads as null. A supplied-but-undefined binding is null.
 */
export const readBinding = (
  name: string,
  optional: boolean | undefined,
  bindings: Record<string, RuleValue> | undefined,
): RuleValue => {
  if (!bindings || !Object.hasOwn(bindings, name)) {
    if (optional === true) return null;
    throw new Error(`Missing binding for "${name}"`);
  }
  const bound = bindings[name];
  return bound === undefined ? null : bound;
};

/** A `{ bind }` the compilers meet unresolved: null when optional, a caller bug otherwise. */
export const compileBinding = (
  name: string,
  optional: boolean | undefined,
  rail: 'toSql' | 'toPrisma',
): null => {
  if (optional === true) return null;
  throw new UsageError(
    `Unresolved binding '${name}' — resolve bindings (bindRule / bindLens) before compiling with ${rail}().`,
  );
};

/** check(): what a value source reads — the literal, the bound value, or the path read. */
export const readValueSource = (
  source: Source,
  scopes: Scopes,
  bindings?: Record<string, RuleValue>,
): unknown =>
  matchSource<unknown>(source, {
    value: (value) => value,
    bind: (name, optional) => readBinding(name, optional, bindings),
    path: (ref) => readPath(ref, scopes) ?? null,
  });

/** How a rail reads a source whose value it needs now (an amount, a zone). */
export type ReadSource = (source: ValueSourceOf<unknown>) => unknown;
