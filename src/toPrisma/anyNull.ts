import { engineGlobals } from '../engineGlobals';

// Prisma matches a DB NULL, a JSON null and an absent Json path together only with its AnyNull
// instance, which it knows by identity. The default is your own @prisma/client's (an optional
// peer dependency); `engineGlobals.set('prismaOptions.anyNull', …)` overrides it.

const RUNTIMES = ['@prisma/client/runtime/client', '@prisma/client/runtime/library'];

let installed: unknown;

const installedAnyNull = (): unknown => {
  if (installed !== undefined) return installed;
  for (const load of loaders()) {
    for (const id of RUNTIMES) {
      try {
        const runtime = load(id) as { AnyNull?: unknown };
        if (runtime.AnyNull !== undefined) {
          installed = runtime.AnyNull;
          return installed;
        }
      } catch {
        // Not this Prisma version's runtime path, or no @prisma/client: try the next.
      }
    }
  }
  return undefined;
};

type Require = (id: string) => unknown;
type BuiltinModule = { createRequire?: (url: string) => Require };
type Process = { getBuiltinModule?: (id: string) => BuiltinModule | undefined };

// No top-level 'node:module' import: browser bundles reach this file. On a server the module
// loader comes from the runtime itself (Node ≥20.16, Bun); ESM resolves from this module's URL,
// the CJS build also has `require` (and no import.meta.url).
const loaders = (): Require[] => {
  const out: Require[] = [];
  try {
    const createRequire = (globalThis as { process?: Process }).process?.getBuiltinModule?.(
      'module',
    )?.createRequire;
    if (createRequire) out.push(createRequire(import.meta.url));
  } catch {
    // CJS: import.meta.url is empty.
  }
  if (typeof require === 'function') out.push(require);
  return out;
};

export const prismaAnyNull = (): unknown => {
  const anyNull = engineGlobals.get('prismaOptions.anyNull') ?? installedAnyNull();
  if (anyNull === undefined)
    throw new Error(
      "A null check on a Json field needs Prisma's AnyNull, and @prisma/client isn't installed: engineGlobals.set('prismaOptions.anyNull', Prisma.AnyNull).",
    );
  return anyNull;
};
