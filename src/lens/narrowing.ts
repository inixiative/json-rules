import type { FieldMapSet } from '../fieldMap/types.ts';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import { checkRuleAgainstLens } from './checkRule.ts';
import type { Lens, LensNarrowing, ModelNarrowing } from './types.ts';
import { getRoot, isLens, resolveRelationTarget } from './walk.ts';

// Ancestors of `narrowing` between (root Lens, narrowing], in root → parent order.
const collectAncestors = (narrowing: LensNarrowing): LensNarrowing[] => {
  const list: LensNarrowing[] = [];
  const visited = new Set<LensNarrowing>();
  let cursor: Lens | LensNarrowing = narrowing.parent;
  while (!isLens(cursor)) {
    if (visited.has(cursor)) throw new Error('cycle detected in narrowing parent chain');
    visited.add(cursor);
    list.unshift(cursor);
    cursor = cursor.parent;
  }
  return list;
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
    const target = resolveRelationTarget(entry, mapName);
    if (!target) continue;
    const targetFields = set.maps[target.mapName]?.[target.modelName]?.fields;
    if (!targetFields) {
      errors.push(`${position}.relations.${relField}: target model not found in lens`);
      continue;
    }
    const childAncestorChain = ancestorChain
      .map((anc) => anc.relations?.[relField])
      .filter((x): x is ModelNarrowing => x !== undefined);
    validateModelNode(
      sub,
      childAncestorChain,
      targetFields,
      target.mapName,
      set,
      `${position}.relations.${relField}`,
      errors,
    );
  }
};

export const validateNarrowing = (narrowing: LensNarrowing): void => {
  const errors: string[] = [];
  const set = getRoot(narrowing);
  const ancestors = collectAncestors(narrowing);

  for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
    const fieldMap = set.maps[mapName];
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

  if (narrowing.constrains !== undefined) {
    const check = checkRuleAgainstLens(narrowing.constrains, narrowing);
    for (const v of check.violations) {
      errors.push(`constrains: '${v.path}' ${v.reason}`);
    }
  }

  if (errors.length) {
    throw new Error(`validateNarrowing:\n${errors.join('\n')}`);
  }
};
