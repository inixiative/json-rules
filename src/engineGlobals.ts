import { cloneDeep, get, set } from 'lodash-es';

export type PrismaProvider =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'sqlserver'
  | 'cockroachdb'
  | 'mongodb';

export type EngineGlobalsState = {
  // Default case-insensitivity for string operators; a rule's own `caseInsensitive` overrides it.
  string: {
    caseInsensitive: boolean;
  };
  prismaOptions: {
    datasource: {
      provider: PrismaProvider;
    };
  };
};

const DEFAULTS: EngineGlobalsState = {
  string: {
    caseInsensitive: false,
  },
  prismaOptions: {
    datasource: {
      provider: 'postgresql',
    },
  },
};

let store: EngineGlobalsState = cloneDeep(DEFAULTS);

export const engineGlobals = {
  set: (path: string, value: unknown): void => {
    set(store, path, cloneDeep(value));
  },
  get: (path: string): unknown => get(store, path),
  reset: (): void => {
    store = cloneDeep(DEFAULTS);
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
