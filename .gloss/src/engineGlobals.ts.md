# src/engineGlobals.ts

## EngineGlobalsState

> `string: {`

Defaults for string operators; a rule's own `caseInsensitive` / `fuzzy` overrides them.

## engineGlobals

> `with: <T>(partial: DeepPartial<EngineGlobalsState>, fn: () => T): T => {`

Scoped override: merge `partial` over the current state, run `fn`, restore. SYNCHRONOUS
ONLY — JS run-to-completion makes a sync `fn` atomic, so overlapping evaluations never
observe the override. An async `fn` would yield mid-scope and leak/collide, so it throws.

## QUERY_MODE_PROVIDERS

> `const QUERY_MODE_PROVIDERS: ReadonlySet<PrismaProvider> = new Set([`

Providers whose Prisma connector accepts `mode: 'insensitive'` (QueryMode). The
rest are case-insensitive by collation and reject the argument.

## resolveCaseInsensitive

> `export const resolveCaseInsensitive = (ruleFlag?: boolean): boolean =>`

A rule's explicit flag wins; otherwise fall back to the engine-global default.

## resolveFuzzy

> `export const resolveFuzzy = (ruleFlag?: boolean | FuzzyConfig): FuzzyConfig | false => {`

Resolve a rule's fuzzy flag against the global default, normalized to a config or false.
