import { RE2JS } from 're2js';

// A rule's pattern runs on RE2, in time linear in its input, so an untrusted rule can't stall
// check() — Postgres's own engine doesn't backtrack either. A pattern RE2 can't run (a
// backreference, a lookaround) is refused on every rail; of a RegExp's flags only `i` reads,
// which SQL writes as `~*`.

export type Pattern = { source: string; caseInsensitive: boolean; re: RE2JS };

export const readPattern = (value: string | RegExp): Pattern => {
  const source = value instanceof RegExp ? value.source : value;
  const flags = value instanceof RegExp ? value.flags : '';
  if (/[^i]/.test(flags))
    throw new Error(`Refused pattern /${source}/${flags}: only the 'i' flag is supported`);
  const caseInsensitive = flags === 'i';
  try {
    return {
      source,
      caseInsensitive,
      re: RE2JS.compile(source, caseInsensitive ? RE2JS.CASE_INSENSITIVE : 0),
    };
  } catch (error) {
    throw new Error(`Refused pattern /${source}/: ${(error as Error).message}`);
  }
};

/** Why a pattern is refused, or null. */
export const patternProblem = (value: string | RegExp): string | null => {
  try {
    readPattern(value);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};
