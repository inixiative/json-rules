import { cloneDeep, cloneDeepWith, isEqual, isPlainObject, merge, set } from 'lodash-es';
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

/**
 * Each path `engineGlobals` reads and writes, and the values it takes. An interface, so a library
 * built on the engine adds its own namespace's paths by module augmentation:
 *
 * ```ts
 * declare module '@inixiative/json-rules' {
 *   interface EngineGlobalValues { 'permissions.idField': string }
 * }
 * ```
 */
export interface EngineGlobalValues {
  'string.caseInsensitive': EngineGlobalsState['string']['caseInsensitive'];
  'string.fuzzy': EngineGlobalsState['string']['fuzzy'];
  'prismaOptions.datasource.provider': EngineGlobalsState['prismaOptions']['datasource']['provider'];
  'prismaOptions.anyNull': EngineGlobalsState['prismaOptions']['anyNull'];
  'sql.dialect': EngineGlobalsState['sql']['dialect'];
  'clock.finestUnit': EngineGlobalsState['clock']['finestUnit'];
}
export type EngineGlobalPath = keyof EngineGlobalValues;

/** The defaults a namespace registers: its paths, relative to the namespace. */
export type EngineGlobalDefaults<N extends string> = {
  [P in EngineGlobalPath as P extends `${N}.${infer K}` ? K : never]: EngineGlobalValues[P];
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

type Overrides = Partial<EngineGlobalValues> | DeepPartial<EngineGlobalsState>;

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

const RESERVED = new Set(Object.keys(DEFAULTS));

// Plain data is copied; an instance (Prisma's AnyNull) is held as given — Prisma knows it by
// identity.
const copy = <T>(value: T): T =>
  cloneDeepWith(value, (v) =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !isPlainObject(v) ? v : undefined,
  );

type Holder = {
  store: Record<string, unknown>;
  registry: Map<string, Record<string, unknown>>;
};

// One store per process, whatever number of json-rules copies are loaded (a nested install, or
// a bundler loading both the ESM and the CJS build): every 3.x copy finds the same holder.
const HOLDER = Symbol.for('@inixiative/json-rules/engineGlobals@3');

const holder = (): Holder => {
  const root = globalThis as typeof globalThis & { [HOLDER]?: Holder };
  root[HOLDER] ??= { store: cloneDeep(DEFAULTS), registry: new Map() };
  return root[HOLDER];
};

// A flat override (`{ 'sql.dialect': 'mysql' }`) as the nested shape the store holds.
const nested = (overrides: Overrides): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (key.includes('.')) set(out, key, copy(value));
    else out[key] = merge(out[key] ?? {}, copy(value));
  }
  return out;
};

const applyUnder = (store: Record<string, unknown>, namespace: string, defaults: object) => {
  for (const [key, value] of Object.entries(defaults)) {
    const path = `${namespace}.${key}`;
    if (readOwnPath(store, path) === undefined) set(store, path, copy(value));
  }
};

const isThenable = (v: unknown): boolean =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/**
 * Register a library's namespace of engine globals and its defaults. A library built on the
 * engine calls this at the top of the module that reads the setting, for its own namespace only.
 * Defaults go in under any value already set (an app may configure a library before importing
 * it). Registering the same defaults again is a no-op (a second installed copy of the library);
 * different defaults, a dotted namespace or one of the engine's own roots throw.
 */
export const registerEngineGlobals = <N extends string>(
  namespace: N,
  defaults: EngineGlobalDefaults<N>,
): void => {
  if (!namespace || namespace.includes('.'))
    throw new Error(`engine globals namespace "${namespace}" must be one non-empty segment`);
  if (RESERVED.has(namespace))
    throw new Error(`engine globals namespace "${namespace}" belongs to json-rules`);
  const { store, registry } = holder();
  const known = registry.get(namespace);
  if (known) {
    if (isEqual(known, defaults)) return;
    throw new Error(`engine globals namespace "${namespace}" is registered with other defaults`);
  }
  registry.set(namespace, copy(defaults as Record<string, unknown>));
  applyUnder(store, namespace, defaults);
};

/** Process-wide defaults, read and written by dotted path (`EngineGlobalPath`). */
export const engineGlobals = {
  set: <P extends EngineGlobalPath>(path: P, value: EngineGlobalValues[P]): void => {
    set(holder().store, path, copy(value));
  },
  get: <P extends EngineGlobalPath>(path: P): EngineGlobalValues[P] =>
    readOwnPath(holder().store, path) as EngineGlobalValues[P],
  // Back to the engine's defaults and every registered namespace's.
  reset: (): void => {
    const target = holder();
    target.store = cloneDeep(DEFAULTS);
    for (const [namespace, defaults] of target.registry)
      applyUnder(target.store, namespace, defaults);
  },
  // Scoped override: merge `overrides` (flat paths, or the nested shape) over the current state,
  // run `fn`, restore. SYNCHRONOUS ONLY — JS run-to-completion makes a sync `fn` atomic, so
  // overlapping evaluations never observe the override. An async `fn` would yield mid-scope and
  // leak/collide, so it throws. A `set` inside `fn` is discarded on restore.
  with: <T>(overrides: Overrides, fn: () => T): T => {
    const target = holder();
    const prev = target.store;
    target.store = merge(copy(prev), nested(overrides));
    try {
      const result = fn();
      if (isThenable(result))
        throw new Error(
          'engineGlobals.with() callback must be synchronous (it returned a Promise).',
        );
      return result;
    } finally {
      target.store = prev;
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
