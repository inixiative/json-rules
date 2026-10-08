export type Scopes = readonly unknown[];

export type ScopeRef = { depth: number; path: string };

const SCOPE_REF = /^(\$+)\.(.*)$/;

/** A `$`-prefixed ref's depth (one per `$`) and the path after it; `null` for a bare ref. */
export const parseScopeRef = (ref: string): ScopeRef | null => {
  const match = SCOPE_REF.exec(ref);
  return match ? { depth: match[1].length, path: match[2] } : null;
};

export const scopeOutOfBounds = (ref: string, depth: number, available: number): string =>
  `Scope ref '${ref}' needs depth ${depth} but only ${available} ${available === 1 ? 'scope is' : 'scopes are'} in reach`;

export type ScopedRef<S> = { scope: S; path: string };
export type ScopeOutOfBounds = { outOfBounds: string };

/** The scope a ref names in a stack (innermost last) and the path left to read in it: a bare
 *  ref and `$.` read the innermost, `$$.` the one above it, … A ref deeper than the stack comes
 *  back as `{ outOfBounds }` with its message; it never throws. */
export const readScopeRef = <S>(
  ref: string,
  scopes: readonly S[],
): ScopedRef<S> | ScopeOutOfBounds => {
  const parsed = parseScopeRef(ref);
  if (!parsed) return { scope: scopes[scopes.length - 1], path: ref };
  if (parsed.depth > scopes.length)
    return { outOfBounds: scopeOutOfBounds(ref, parsed.depth, scopes.length) };
  return { scope: scopes[scopes.length - parsed.depth], path: parsed.path };
};

// Segments of a path: dotted names, bracket indices and quoted keys (`ids[1]`, `meta["a.b"]`).
const SEGMENT = /\[(\d+)\]|\[(["'])(.*?)\2\]|([^.[\]]+)/g;
const segments = (path: string): string[] =>
  path === '' ? [''] : [...path.matchAll(SEGMENT)].map((m) => m[1] ?? m[3] ?? m[4]);

// One step of a path read: an own property, or an inherited one (a class getter, a string's
// `length`) unless Object.prototype names it — `constructor`, `toString`, `__proto__` never
// resolve — and never a method.
const step = (at: unknown, key: string): unknown => {
  if (at === null || at === undefined) return undefined;
  const boxed = Object(at) as Record<string, unknown>;
  if (Object.hasOwn(boxed, key)) return boxed[key];
  if (key in Object.prototype || !(key in boxed)) return undefined;
  const value = boxed[key];
  return typeof value === 'function' ? undefined : value;
};

/** A path read that never reaches Object.prototype: own properties, inherited getters and data,
 *  bracket indices. */
export const readOwnPath = (root: unknown, path: string): unknown =>
  segments(path).reduce<unknown>(step, root);

export const readField = (ref: string, scopes: Scopes): unknown => {
  const target = readScopeRef(ref, scopes);
  if ('outOfBounds' in target) throw new Error(target.outOfBounds);
  return readOwnPath(target.scope, target.path);
};

export const readPath = (ref: string, scopes: Scopes, context: unknown): unknown =>
  parseScopeRef(ref) ? readField(ref, scopes) : readOwnPath(context, ref);

export const checkOnlyScopeRef = (ref: string, rail: 'toSql' | 'toPrisma'): string =>
  `Scope ref '${ref}' is not supported by ${rail}(); evaluate with check()`;

export const rejectScopedField = (condition: object, rail: 'toSql' | 'toPrisma'): void => {
  if (!('field' in condition) || typeof condition.field !== 'string') return;
  if (parseScopeRef(condition.field)) throw new Error(checkOnlyScopeRef(condition.field, rail));
};

/** A compiler's bare (context) ref: the context it was given, which must be there. A path that
 *  reads nothing reads null. */
export const readContextRef = (
  ref: string,
  context: unknown,
  rail: 'toSql' | 'toPrisma',
): unknown => {
  if (!context)
    throw new Error(
      `context is required to resolve path '${ref}'. Pass context when calling ${rail}().`,
    );
  return readOwnPath(context, ref) ?? null;
};
