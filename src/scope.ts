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

const readScoped = (ref: string, parsed: ScopeRef, scopes: Scopes): unknown => {
  if (parsed.depth > scopes.length)
    throw new Error(scopeOutOfBounds(ref, parsed.depth, scopes.length));
  return get(scopes[scopes.length - parsed.depth], parsed.path);
};

export const readField = (ref: string, scopes: Scopes): unknown => {
  const parsed = parseScopeRef(ref);
  return parsed ? readScoped(ref, parsed, scopes) : get(scopes[scopes.length - 1], ref);
};

export const readPath = (ref: string, scopes: Scopes, context: unknown): unknown => {
  const parsed = parseScopeRef(ref);
  return parsed ? readScoped(ref, parsed, scopes) : get(context, ref);
};
