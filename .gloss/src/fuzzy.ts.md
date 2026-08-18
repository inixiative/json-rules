# src/fuzzy.ts

## FuzzyConfig

> `export type FuzzyConfig = {`

Fully JSON-serializable — a rule carries this over the wire, so no functions here.

> `maxDistance?: number;`

flat edit-distance budget

> `maxRatio?: number;`

or a fraction of token length (0..1): floor(length * maxRatio)

## maxFuzzyDistance

> `export const maxFuzzyDistance = (length: number): number => {`

Short tokens must match exactly (so 2-3 char terms don't fuzz-match half the corpus);
longer tokens tolerate more typos.

## resolveMaxDistance

> `const resolveMaxDistance = (config: FuzzyConfig, length: number): number => {`

maxDistance (absolute) and maxRatio (fraction of length) are both caps — the tighter one
wins, so `{ maxRatio: 0.2, maxDistance: 2 }` is "≤20% of chars, but never more than 2".
With neither set, fall back to the default length curve.

## fuzzyContains

> `export const fuzzyContains = (`

True when every token in `query` matches `haystack` — as an exact substring of the whole
haystack, or within a length-scaled edit distance of some haystack token. Multi-word
queries AND their tokens; numbers are identity (never typo-corrected). Inputs lowercased.
