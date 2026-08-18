import { cloneDeep, get, merge, set } from 'lodash-es';
import type { FuzzyConfig } from './fuzzy';

export type PrismaProvider =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'sqlserver'
  | 'cockroachdb'
  | 'mongodb';

// gloss
export type EngineGlobalsState = {
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

// gloss
export const engineGlobals = {
  set: (path: string, value: unknown): void => {
    set(store, path, cloneDeep(value));
  },
  get: (path: string): unknown => get(store, path),
  reset: (): void => {
    store = cloneDeep(DEFAULTS);
  },
  with: <T>(partial: DeepPartial<EngineGlobalsState>, fn: () => T): T => {
    const prev = store;
    store = merge(cloneDeep(prev), partial);
    try {
      const result = fn();
      // why: a sync fn is atomic under run-to-completion; an async fn yields mid-scope and leaks the override
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

// gloss
const QUERY_MODE_PROVIDERS: ReadonlySet<PrismaProvider> = new Set([
  'postgresql',
  'cockroachdb',
  'mongodb',
]);

export const supportsQueryMode = (provider: PrismaProvider): boolean =>
  QUERY_MODE_PROVIDERS.has(provider);

// gloss
export const resolveCaseInsensitive = (ruleFlag?: boolean): boolean =>
  ruleFlag ?? (engineGlobals.get('string.caseInsensitive') as boolean | undefined) ?? false;

// gloss
export const resolveFuzzy = (ruleFlag?: boolean | FuzzyConfig): FuzzyConfig | false => {
  const resolved =
    ruleFlag ?? (engineGlobals.get('string.fuzzy') as boolean | FuzzyConfig | undefined) ?? false;
  if (!resolved) return false;
  return resolved === true ? {} : resolved;
};
