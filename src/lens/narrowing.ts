import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import type { Lens, LensNarrowing, ModelNarrowing } from './types.ts';

const isLens = (x: Lens | LensNarrowing): x is Lens => 'model' in x;

const getRoot = (x: Lens | LensNarrowing): Lens => (isLens(x) ? x : getRoot(x.parent));

// Ancestors of `narrowing` between (root Lens, narrowing], in root → parent order.
// Excludes the lens at the root and includes the immediate parent narrowing chain.
const collectAncestors = (narrowing: LensNarrowing): LensNarrowing[] => {
  const list: LensNarrowing[] = [];
  let cursor: Lens | LensNarrowing = narrowing.parent;
  while (!isLens(cursor)) {
    list.unshift(cursor);
    cursor = cursor.parent;
  }
  return list;
};

const asSet = (lens: Lens): FieldMapSet => {
  const first = Object.values(lens.map)[0];
  if (first && 'fields' in first) {
    const key = lens.mapName ?? 'default';
    return { [key]: lens.map as FieldMap };
  }
  return lens.map as FieldMapSet;
};

const resolveRelationTarget = (
  entry: FieldMapEntry,
  currentMap: string,
  set: FieldMapSet,
): { fields: Record<string, FieldMapEntry>; mapName: string } | null => {
  if (entry.kind === 'object') {
    const fields = set[currentMap]?.[entry.type]?.fields;
    return fields ? { fields, mapName: currentMap } : null;
  }
  if (entry.kind === 'bridge') {
    const [m, n] = entry.type.includes(':') ? entry.type.split(':') : [currentMap, entry.type];
    const fields = set[m]?.[n]?.fields;
    return fields ? { fields, mapName: m } : null;
  }
  return null;
};

const validateModelNode = (
  narrowing: ModelNarrowing,
  ancestorChain: ModelNarrowing[],
  modelFields: Record<string, FieldMapEntry>,
  mapName: string,
  set: FieldMapSet,
  position: string,
  errors: string[],
): void => {
  if (narrowing.picks && narrowing.omits) {
    errors.push(`${position}: cannot specify both picks and omits`);
  }

  for (const f of narrowing.picks ?? []) {
    if (!modelFields[f]) {
      errors.push(`${position}.picks: field '${f}' not on model`);
      continue;
    }
    for (const anc of ancestorChain) {
      if (anc.picks && !anc.picks.includes(f)) {
        errors.push(`${position}.picks: '${f}' not in ancestor's picks`);
        break;
      }
      if (anc.omits?.includes(f)) {
        errors.push(`${position}.picks: '${f}' was omitted by ancestor`);
        break;
      }
    }
  }

  for (const f of narrowing.omits ?? []) {
    if (!modelFields[f]) {
      errors.push(`${position}.omits: field '${f}' not on model`);
      continue;
    }
    for (const anc of ancestorChain) {
      if (anc.picks && !anc.picks.includes(f)) {
        errors.push(`${position}.omits: '${f}' not in ancestor's picks (already invisible)`);
        break;
      }
    }
  }

  for (const [relField, sub] of Object.entries(narrowing.relations ?? {})) {
    const entry = modelFields[relField];
    if (!entry) {
      errors.push(`${position}.relations: '${relField}' not on model`);
      continue;
    }
    if (entry.kind !== 'object' && entry.kind !== 'bridge') {
      errors.push(`${position}.relations: '${relField}' is not a relation (kind=${entry.kind})`);
      continue;
    }
    const target = resolveRelationTarget(entry, mapName, set);
    if (!target) {
      errors.push(`${position}.relations.${relField}: target model not found in lens`);
      continue;
    }
    const childAncestorChain = ancestorChain
      .map((anc) => anc.relations?.[relField])
      .filter((x): x is ModelNarrowing => x !== undefined);
    validateModelNode(
      sub,
      childAncestorChain,
      target.fields,
      target.mapName,
      set,
      `${position}.relations.${relField}`,
      errors,
    );
  }
};

export const validateNarrowing = (narrowing: LensNarrowing): void => {
  const errors: string[] = [];
  const root = getRoot(narrowing);
  const set = asSet(root);
  const ancestors = collectAncestors(narrowing);

  for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
    const fieldMap = set[mapName];
    if (!fieldMap) {
      errors.push(`maps.${mapName}: not in lens`);
      continue;
    }
    for (const [modelName, modelNarrowing] of Object.entries(mapNarrowing.models)) {
      const model = fieldMap[modelName];
      if (!model) {
        errors.push(`maps.${mapName}.models.${modelName}: not in fieldMap`);
        continue;
      }
      const ancestorChain = ancestors
        .map((anc) => anc.maps[mapName]?.models[modelName])
        .filter((x): x is ModelNarrowing => x !== undefined);
      validateModelNode(
        modelNarrowing,
        ancestorChain,
        model.fields,
        mapName,
        set,
        `maps.${mapName}.models.${modelName}`,
        errors,
      );
    }
  }

  if (errors.length) {
    throw new Error(`validateNarrowing:\n${errors.join('\n')}`);
  }
};
