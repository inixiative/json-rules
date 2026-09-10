import { get } from 'lodash-es';

export type Scopes = readonly unknown[];

export type ScopeRef = { depth: number; path: string };

const SCOPE_REF = /^(\$+)\.(.*)$/;

export const parseScopeRef = (ref: string): ScopeRef | null => {
  const match = SCOPE_REF.exec(ref);
  return match ? { depth: match[1].length, path: match[2] } : null;
};

export const scopeOutOfBounds = (ref: string, depth: number, available: number): string =>
  `Scope ref '${ref}' needs depth ${depth} but only ${available} ${available === 1 ? 'scope is' : 'scopes are'} in reach`;

export type ScopedRef<S> = { scope: S; path: string };
export type ScopeOutOfBounds = { outOfBounds: string };

// Resolves a ref against a stack of scopes (innermost last): a bare ref is the innermost
// scope, `$.` the innermost, `$$.` the one above it, … A ref deeper than the stack is
// out of bounds and carries its message.
export const resolveScopeRef = <S>(
  ref: string,
  scopes: readonly S[],
): ScopedRef<S> | ScopeOutOfBounds => {
  const parsed = parseScopeRef(ref);
  if (!parsed) return { scope: scopes[scopes.length - 1], path: ref };
  if (parsed.depth > scopes.length)
    return { outOfBounds: scopeOutOfBounds(ref, parsed.depth, scopes.length) };
  return { scope: scopes[scopes.length - parsed.depth], path: parsed.path };
};

const readScoped = (ref: string, scopes: Scopes): unknown => {
  const target = resolveScopeRef(ref, scopes);
  if ('outOfBounds' in target) throw new Error(target.outOfBounds);
  return get(target.scope, target.path);
};

export const readField = (ref: string, scopes: Scopes): unknown => readScoped(ref, scopes);

export const readPath = (ref: string, scopes: Scopes, context: unknown): unknown =>
  parseScopeRef(ref) ? readScoped(ref, scopes) : get(context, ref);

export const checkOnlyScopeRef = (ref: string, rail: 'toSql' | 'toPrisma'): string =>
  `Scope ref '${ref}' is not supported by ${rail}(); evaluate with check()`;

export const rejectScopedField = (condition: object, rail: 'toSql' | 'toPrisma'): void => {
  if (!('field' in condition) || typeof condition.field !== 'string') return;
  if (parseScopeRef(condition.field)) throw new Error(checkOnlyScopeRef(condition.field, rail));
};
