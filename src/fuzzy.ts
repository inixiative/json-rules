import { distance } from 'fastest-levenshtein';

// Fully JSON-serializable — a rule carries this over the wire, so no functions here.
export type FuzzyConfig = {
  maxDistance?: number; // flat edit-distance budget
  maxRatio?: number; // or a fraction of token length (0..1): floor(length * maxRatio)
};

// Short tokens must match exactly (so 2-3 char terms don't fuzz-match half the corpus);
// longer tokens tolerate more typos.
export const maxFuzzyDistance = (length: number): number => {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
};

// maxDistance (absolute) and maxRatio (fraction of length) are both caps — the tighter one
// wins, so `{ maxRatio: 0.2, maxDistance: 2 }` is "≤20% of chars, but never more than 2".
// With neither set, fall back to the default length curve.
const resolveMaxDistance = (config: FuzzyConfig, length: number): number => {
  const { maxDistance, maxRatio } = config;
  const caps: number[] = [];
  if (typeof maxDistance === 'number') caps.push(maxDistance);
  if (typeof maxRatio === 'number') caps.push(Math.floor(length * maxRatio));
  return caps.length > 0 ? Math.min(...caps) : maxFuzzyDistance(length);
};

const tokenize = (value: string): string[] => value.split(/[^a-z0-9\p{L}]+/u).filter(Boolean);

const isNumeric = (token: string): boolean => /^\d+$/.test(token);

const withinDistance = (a: string, b: string, max: number): boolean => {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  return distance(a, b) <= max;
};

// True when every token in `query` matches `haystack` — as an exact substring of the whole
// haystack, or within a length-scaled edit distance of some haystack token. Multi-word
// queries AND their tokens; numbers are identity (never typo-corrected). Inputs lowercased.
export const fuzzyContains = (
  haystack: string,
  query: string,
  config: FuzzyConfig = {},
): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  const hay = haystack.toLowerCase();
  if (hay.includes(needle)) return true;

  const queryTokens = tokenize(needle);
  if (queryTokens.length === 0) return false;

  const hayTokens = tokenize(hay);
  if (hayTokens.length === 0) return false;

  return queryTokens.every((token) => {
    const max = resolveMaxDistance(config, token.length);
    if (max === 0 || isNumeric(token)) return hayTokens.includes(token);
    return hayTokens.some((hayToken) => withinDistance(token, hayToken, max));
  });
};
