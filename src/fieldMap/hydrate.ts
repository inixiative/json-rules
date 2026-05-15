import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import type { FieldMapSet } from './types.ts';

export type ProviderResolver = (
  source: string,
) => Promise<Record<string, FieldMapEntry>> | Record<string, FieldMapEntry>;

export const hydrateFieldMap = async (
  map: FieldMap,
  resolve: ProviderResolver,
): Promise<FieldMap> => {
  const out: FieldMap = structuredClone(map);
  for (const model of Object.values(out)) {
    if (!model.providers?.length) continue;
    for (const provider of model.providers) {
      const injected = await resolve(provider.source);
      Object.assign(model.fields, injected);
    }
  }
  return out;
};

export const hydrateFieldMapSet = async (
  set: FieldMapSet,
  resolve: ProviderResolver,
): Promise<FieldMapSet> => {
  const out: FieldMapSet = {};
  for (const [name, map] of Object.entries(set)) {
    out[name] = await hydrateFieldMap(map, resolve);
  }
  return out;
};
