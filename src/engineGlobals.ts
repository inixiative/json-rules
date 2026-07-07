import { cloneDeep, get, merge, set } from 'lodash-es';
import type { FuzzyConfig } from './fuzzy';

export type PrismaProvider =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'sqlserver'
  | 'cockroachdb'
  | 'mongodb';

export type EngineGlobalsState = {
  // Defaults for string operators; a rule's own `caseInsensitive` / `fuzzy` overrides them.
  string: {
    caseInsensitive: boolean;
    fuzzy: boolean | FuzzyConfig;
  };
  prismaOptions: {
    datasource: {
      provider: PrismaProvider;
    };
  };
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const DEFAULTS: EngineGlobalsState = {
  string: {
    caseInsensitive: false,
    fuzzy: false,
  },
  prismaOptions: {
    datasource: {
      provider: 'postgresql',
    },
  },
};

let store: EngineGlobalsState = cloneDeep(DEFAULTS);

const isThenable = (v: unknown): boolean =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

export const engineGlobals = {
  set: (path: string, value: unknown): void => {
    set(store, path, cloneDeep(value));
  },
  get: (path: string): unknown => get(store, path),
  reset: (): void => {
    store = cloneDeep(DEFAULTS);
  },
  // Scoped override: merge `partial` over the current state, run `fn`, restore. SYNCHRONOUS
  // ONLY — JS run-to-completion makes a sync `fn` atomic, so overlapping evaluations never
  // observe the override. An async `fn` would yield mid-scope and leak/collide, so it throws.
  with: <T>(partial: DeepPartial<EngineGlobalsState>, fn: () => T): T => {
    const prev = store;
    store = merge(cloneDeep(prev), partial);
    try {
      const result = fn();
      if (isThenable(result))
        throw new Error(
          'engineGlobals.with() callback must be synchronous (it returned a Promise).',
        );
      return result;
    } finally {
      store = prev;
    }
  },
};

// Providers whose Prisma connector accepts `mode: 'insensitive'` (QueryMode). The
// rest are case-insensitive by collation and reject the argument.
const QUERY_MODE_PROVIDERS: ReadonlySet<PrismaProvider> = new Set([
  'postgresql',
  'cockroachdb',
  'mongodb',
]);

export const supportsQueryMode = (provider: PrismaProvider): boolean =>
  QUERY_MODE_PROVIDERS.has(provider);

// A rule's explicit flag wins; otherwise fall back to the engine-global default.
export const resolveCaseInsensitive = (ruleFlag?: boolean): boolean =>
  ruleFlag ?? (engineGlobals.get('string.caseInsensitive') as boolean | undefined) ?? false;

// Resolve a rule's fuzzy flag against the global default, normalized to a config or false.
export const resolveFuzzy = (ruleFlag?: boolean | FuzzyConfig): FuzzyConfig | false => {
  const resolved =
    ruleFlag ?? (engineGlobals.get('string.fuzzy') as boolean | FuzzyConfig | undefined) ?? false;
  if (!resolved) return false;
  return resolved === true ? {} : resolved;
};
