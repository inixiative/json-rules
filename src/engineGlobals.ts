import { cloneDeep, get, set } from 'lodash-es';

export type PrismaProvider =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'sqlserver'
  | 'cockroachdb'
  | 'mongodb';

export type EngineGlobalsState = {
  prismaOptions: {
    datasource: {
      provider: PrismaProvider;
    };
  };
};

const DEFAULTS: EngineGlobalsState = {
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
