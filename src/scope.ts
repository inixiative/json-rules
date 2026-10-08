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

// One step of a path read: an own property only (an array's index or `length`, a string's
// `length`) — never an inherited one (a class getter, a method, `constructor`, `toString`).
const step = (at: unknown, key: string): unknown => {
  if (at === null || at === undefined) return undefined;
  const boxed = Object(at) as Record<string, unknown>;
  return Object.hasOwn(boxed, key) ? boxed[key] : undefined;
};

/** A path read of own properties only, bracket indices included: nothing inherited resolves. */
export const readOwnPath = (root: unknown, path: string): unknown =>
  segments(path).reduce<unknown>(step, root);

export const readField = (ref: string, scopes: Scopes): unknown => {
  const target = readScopeRef(ref, scopes);
  if ('outOfBounds' in target) throw new Error(target.outOfBounds);
  return readOwnPath(target.scope, target.path);
};

/** A value ref: `$.` reads the current element, each further `$` one scope out; a bare ref reads
 *  the root row. */
export const readPath = (ref: string, scopes: Scopes): unknown =>
  parseScopeRef(ref) ? readField(ref, scopes) : readOwnPath(scopes[0], ref);

export const checkOnlyScopeRef = (ref: string, rail: 'toSql' | 'toPrisma'): string =>
  `Scope ref '${ref}' is not supported by ${rail}(); evaluate with check()`;

export const rejectScopedField = (condition: object, rail: 'toSql' | 'toPrisma'): void => {
  if (!('field' in condition) || typeof condition.field !== 'string') return;
  if (parseScopeRef(condition.field)) throw new Error(checkOnlyScopeRef(condition.field, rail));
};
