import { distance } from 'fastest-levenshtein';

// gloss
export type FuzzyConfig = {
  maxDistance?: number;
  maxRatio?: number;
};

// gloss
export const maxFuzzyDistance = (length: number): number => {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
};

// gloss
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

// gloss
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
