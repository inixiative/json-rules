import { createRequire } from 'node:module';
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

// ESM resolves from this module's URL; the CJS build has `require` (and no import.meta.url).
const loaders = (): ((id: string) => unknown)[] => {
  const out: ((id: string) => unknown)[] = [];
  try {
    out.push(createRequire(import.meta.url));
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
