import { cloneDeep, cloneDeepWith, isPlainObject, merge, set } from 'lodash-es';
import type { FuzzyConfig } from './fuzzy';
import type { ClockUnit, RelativeUnit } from './operatorCatalog';
import { readOwnPath } from './scope';

export type PrismaProvider =
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'sqlserver'
  | 'cockroachdb'
  | 'mongodb';

/** The SQL dialects the engine writes. `toSql` writes PostgreSQL; `toWhereSql` writes the
 *  engine's `sql.dialect`. */
export const SqlDialect = {
  postgres: 'postgres',
  mysql: 'mysql',
} as const;

export type SqlDialect = (typeof SqlDialect)[keyof typeof SqlDialect];

export const isSqlDialect = (value: unknown): value is SqlDialect =>
  Object.values(SqlDialect).includes(value as SqlDialect);

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
    /** Prisma's `AnyNull` — matches a DB NULL, a JSON null and an absent Json path. Defaults to
     *  your installed @prisma/client's; set it only to use another. */
    anyNull?: unknown;
  };
  sql: {
    /** The dialect SQL-writing functions that take one emit (`toWhereSql`, `toLensWhereSql`). */
    dialect: SqlDialect;
  };
  clock: {
    /** The finest clock unit a rule may read, singular or plural: a rule naming a finer one
     *  fails to evaluate. */
    finestUnit: ClockUnit | RelativeUnit;
  };
};

/** Each path `engineGlobals` reads and writes, and the values it takes. */
export type EngineGlobalValues = {
  'string.caseInsensitive': EngineGlobalsState['string']['caseInsensitive'];
  'string.fuzzy': EngineGlobalsState['string']['fuzzy'];
  'prismaOptions.datasource.provider': EngineGlobalsState['prismaOptions']['datasource']['provider'];
  'prismaOptions.anyNull': EngineGlobalsState['prismaOptions']['anyNull'];
  'sql.dialect': EngineGlobalsState['sql']['dialect'];
  'clock.finestUnit': EngineGlobalsState['clock']['finestUnit'];
};
export type EngineGlobalPath = keyof EngineGlobalValues;

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
  sql: {
    dialect: SqlDialect.postgres,
  },
  clock: {
    finestUnit: 'second',
  },
};

let store: EngineGlobalsState = cloneDeep(DEFAULTS);

// Plain data is copied; an instance (Prisma's AnyNull) is held as given — Prisma knows it by
// identity.
const copy = <T>(value: T): T =>
  cloneDeepWith(value, (v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !isPlainObject(v) ? v : undefined,
  );

const isThenable = (v: unknown): boolean =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/** Process-wide defaults, read and written by dotted path (`EngineGlobalPath`). */
export const engineGlobals = {
  set: <P extends EngineGlobalPath>(path: P, value: EngineGlobalValues[P]): void => {
    set(store, path, copy(value));
  },
  get: <P extends EngineGlobalPath>(path: P): EngineGlobalValues[P] =>
    readOwnPath(store, path) as EngineGlobalValues[P],
  reset: (): void => {
    store = cloneDeep(DEFAULTS);
  },
  // Scoped override: merge `partial` over the current state, run `fn`, restore. SYNCHRONOUS
  // ONLY — JS run-to-completion makes a sync `fn` atomic, so overlapping evaluations never
  // observe the override. An async `fn` would yield mid-scope and leak/collide, so it throws.
  with: <T>(partial: DeepPartial<EngineGlobalsState>, fn: () => T): T => {
    const prev = store;
    store = merge(copy(prev), copy(partial));
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
