import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import { checkRuleAgainstLens } from './checkRule.ts';
import type { LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

// Validates a path-specific ModelNarrowing at one model+path, checking it
// against the chain of ancestor ModelNarrowings at the same path AND against
// same-layer defaults on the same model. Each layer can only mention things
// still visible from layers above + current layer's defaults.
const validateModelNode = (
  narrowing: ModelNarrowing | ModelDefaultNarrowing,
  ancestorChain: ModelNarrowing[],
  sameLayerDefaults: ModelDefaultNarrowing | undefined,
  modelFields: Record<string, FieldMapEntry>,
  modelName: string,
  enumRegistry: Record<string, readonly string[]> | undefined,
  position: string,
  errors: string[],
  isDefault = false,
): void => {
  if (narrowing.picks && narrowing.omits) {
    errors.push(`${position}: cannot specify both picks and omits`);
  }

  // ModelDefaultNarrowing must not declare relations.
  if (isDefault && 'relations' in narrowing && (narrowing as ModelNarrowing).relations) {
    errors.push(
      `${position}: defaults cannot declare 'relations' — relations are path-specific only`,
    );
  }

  for (const f of narrowing.picks ?? []) {
    if (!modelFields[f]) {
      errors.push(`${position}.picks: field '${f}' not on model`);
      continue;
    }
    // Ancestor-chain checks (preserves v2.0 error message format)
    let stopped = false;
    for (const anc of ancestorChain) {
      if (anc.picks && !anc.picks.includes(f)) {
        errors.push(`${position}.picks: '${f}' not in ancestor's picks`);
        stopped = true;
        break;
      }
      if (anc.omits?.includes(f)) {
        errors.push(`${position}.picks: '${f}' was omitted by ancestor`);
        stopped = true;
        break;
      }
    }
    if (stopped) continue;
    // Same-layer defaults check
    if (!isDefault && sameLayerDefaults) {
      if (sameLayerDefaults.picks && !sameLayerDefaults.picks.includes(f)) {
        errors.push(`${position}.picks: '${f}' not visible from defaults.picks`);
      } else if (sameLayerDefaults.omits?.includes(f)) {
        errors.push(`${position}.picks: '${f}' not visible (already excluded by defaults.omits)`);
      }
    }
  }

  for (const f of narrowing.omits ?? []) {
    if (!modelFields[f]) {
      errors.push(`${position}.omits: field '${f}' not on model`);
      continue;
    }
    let stopped = false;
    for (const anc of ancestorChain) {
      if (anc.picks && !anc.picks.includes(f)) {
        errors.push(`${position}.omits: '${f}' not in ancestor's picks (already invisible)`);
        stopped = true;
        break;
      }
      if (anc.omits?.includes(f)) {
        errors.push(`${position}.omits: '${f}' already excluded by ancestor`);
        stopped = true;
        break;
      }
    }
    if (stopped) continue;
    if (!isDefault && sameLayerDefaults) {
      if (sameLayerDefaults.picks && !sameLayerDefaults.picks.includes(f)) {
        errors.push(`${position}.omits: '${f}' not visible from defaults.picks`);
      } else if (sameLayerDefaults.omits?.includes(f)) {
        errors.push(`${position}.omits: '${f}' already excluded by defaults`);
      }
    }
  }

  // enumPicks / enumOmits validation (enum field existence + value membership + visibility)
  const validateEnumOp = (
    op: 'enumPicks' | 'enumOmits',
    fieldName: string,
    values: readonly string[],
  ): void => {
    const fieldEntry = modelFields[fieldName];
    if (!fieldEntry) {
      errors.push(`${position}.${op}: field '${fieldName}' not on model`);
      return;
    }
    if (fieldEntry.kind !== 'enum') {
      errors.push(`${position}.${op}: field '${fieldName}' is not an enum field`);
      return;
    }
    const registry = fieldEntry.values ?? enumRegistry?.[fieldEntry.type];
    for (const v of values) {
      if (registry && !registry.includes(v)) {
        errors.push(
          `${position}.${op}.${fieldName}: '${v}' is not a known value of enum '${fieldEntry.type}'`,
        );
      }
    }
  };
  for (const [field, vals] of Object.entries(narrowing.enumPicks ?? {})) {
    validateEnumOp('enumPicks', field, vals);
  }
  for (const [field, vals] of Object.entries(narrowing.enumOmits ?? {})) {
    validateEnumOp('enumOmits', field, vals);
  }

  // where: field-path check against this model.
  if (narrowing.where !== undefined && narrowing.where !== true && narrowing.where !== false) {
    const result = checkWhereAgainstModel(narrowing.where, modelFields, modelName);
    for (const err of result) errors.push(`${position}.where: ${err}`);
  }
};

const checkWhereAgainstModel = (
  cond: unknown,
  modelFields: Record<string, FieldMapEntry>,
  modelName: string,
): string[] => {
  const errors: string[] = [];
  const visit = (c: unknown): void => {
    if (c === null || typeof c !== 'object') return;
    if (Array.isArray(c)) {
      for (const x of c) visit(x);
      return;
    }
    const obj = c as Record<string, unknown>;
    if ('all' in obj && Array.isArray(obj.all)) {
      for (const x of obj.all) visit(x);
      return;
    }
    if ('any' in obj && Array.isArray(obj.any)) {
      for (const x of obj.any) visit(x);
      return;
    }
    if ('if' in obj) {
      visit(obj.if);
      visit(obj.then);
      if (obj.else !== undefined) visit(obj.else);
      return;
    }
    if ('field' in obj && typeof obj.field === 'string' && obj.field !== '') {
      const top = obj.field.split('.')[0];
      if (!modelFields[top]) {
        errors.push(`'${obj.field}' not on model ${modelName}`);
      }
    }
    if ('condition' in obj && obj.condition !== undefined) visit(obj.condition);
  };
  visit(cond);
  return errors;
};

// Validates defaults.enums entries against the enum registry.
const validateDefaultsEnums = (
  mapName: string,
  defaultsEnums: Record<string, { picks?: readonly string[]; omits?: readonly string[] }>,
  enumRegistry: Record<string, readonly string[]> | undefined,
  ancestorEnumNarrowings: Array<
    Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
  >,
  errors: string[],
): void => {
  for (const [enumName, enumN] of Object.entries(defaultsEnums)) {
    const registryVals = enumRegistry?.[enumName];
    if (!registryVals) {
      errors.push(`maps.${mapName}.defaults.enums.${enumName}: enum not in registry`);
      continue;
    }
    // Compute inherited visibility for this enum from ancestor layers
    let inheritedPicks: Set<string> | null = null;
    const inheritedOmits = new Set<string>();
    for (const anc of ancestorEnumNarrowings) {
      const a = anc[enumName];
      if (!a) continue;
      if (a.picks) {
        inheritedPicks =
          inheritedPicks === null
            ? new Set(a.picks)
            : new Set(a.picks.filter((v) => inheritedPicks?.has(v)));
      }
      if (a.omits) for (const v of a.omits) inheritedOmits.add(v);
    }
    const isInheritedVisible = (v: string): boolean => {
      if (inheritedOmits.has(v)) return false;
      if (inheritedPicks && !inheritedPicks.has(v)) return false;
      return true;
    };
    for (const v of enumN.picks ?? []) {
      if (!registryVals.includes(v)) {
        errors.push(`maps.${mapName}.defaults.enums.${enumName}.picks: '${v}' not a known value`);
      } else if (!isInheritedVisible(v)) {
        errors.push(
          `maps.${mapName}.defaults.enums.${enumName}.picks: '${v}' not visible from ancestors`,
        );
      }
    }
    for (const v of enumN.omits ?? []) {
      if (!registryVals.includes(v)) {
        errors.push(`maps.${mapName}.defaults.enums.${enumName}.omits: '${v}' not a known value`);
      } else if (!isInheritedVisible(v)) {
        errors.push(
          `maps.${mapName}.defaults.enums.${enumName}.omits: '${v}' already excluded by ancestors`,
        );
      }
    }
  }
};

// For per-field enum narrowing on ModelDefaultNarrowing or ModelNarrowing, validate
// that values are visible from same-layer defaults.enums + ancestor defaults.enums chain.
const validateEnumFieldAgainstChain = (
  modelFields: Record<string, FieldMapEntry>,
  narrowing: ModelDefaultNarrowing | ModelNarrowing,
  sameLayerDefaultsEnums:
    | Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
    | undefined,
  ancestorDefaultsEnums: Array<
    Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
  >,
  position: string,
  errors: string[],
): void => {
  const check = (
    op: 'enumPicks' | 'enumOmits',
    fieldName: string,
    values: readonly string[],
  ): void => {
    const entry = modelFields[fieldName];
    if (!entry || entry.kind !== 'enum') return; // already errored elsewhere
    const enumType = entry.type;
    // Inherited visible set for enum type
    let inheritedPicks: Set<string> | null = null;
    const inheritedOmits = new Set<string>();
    const allLayers = [...ancestorDefaultsEnums];
    if (sameLayerDefaultsEnums) allLayers.push(sameLayerDefaultsEnums);
    for (const layer of allLayers) {
      const e = layer[enumType];
      if (!e) continue;
      if (e.picks) {
        inheritedPicks =
          inheritedPicks === null
            ? new Set(e.picks)
            : new Set(e.picks.filter((v) => inheritedPicks?.has(v)));
      }
      if (e.omits) for (const v of e.omits) inheritedOmits.add(v);
    }
    for (const v of values) {
      if (inheritedOmits.has(v)) {
        errors.push(`${position}.${op}.${fieldName}: '${v}' already excluded by defaults.enums`);
      } else if (inheritedPicks && !inheritedPicks.has(v)) {
        errors.push(`${position}.${op}.${fieldName}: '${v}' not allowed by defaults.enums`);
      }
    }
  };
  for (const [f, vals] of Object.entries(narrowing.enumPicks ?? {})) check('enumPicks', f, vals);
  for (const [f, vals] of Object.entries(narrowing.enumOmits ?? {})) check('enumOmits', f, vals);
};

const validatePathNarrowing = (
  narrowing: ModelNarrowing,
  ancestorChain: ModelNarrowing[],
  ancestorDefaults: ModelDefaultNarrowing[],
  sameLayerDefaults: ModelDefaultNarrowing | undefined,
  ancestorDefaultsEnums: Array<
    Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
  >,
  sameLayerDefaultsEnums:
    | Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
    | undefined,
  maps: Record<string, FieldMap>,
  mapName: string,
  modelName: string,
  position: string,
  errors: string[],
): void => {
  const fieldMap = maps[mapName];
  const model = fieldMap?.models[modelName];
  if (!model) return;

  // Synthesize an ancestor-like list for visibility check that includes defaults too
  const synthAncestors = [...ancestorDefaults.map((d) => d as ModelNarrowing), ...ancestorChain];

  validateModelNode(
    narrowing,
    synthAncestors,
    sameLayerDefaults,
    model.fields,
    modelName,
    fieldMap?.enums,
    position,
    errors,
    false,
  );

  validateEnumFieldAgainstChain(
    model.fields,
    narrowing,
    sameLayerDefaultsEnums,
    ancestorDefaultsEnums,
    position,
    errors,
  );

  for (const [relField, sub] of Object.entries(narrowing.relations ?? {})) {
    const entry = model.fields[relField];
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
    if (!maps[target.mapName]?.models[target.modelName]) {
      errors.push(`${position}.relations.${relField}: target model not found in lens`);
      continue;
    }
    const childAncestorChain = ancestorChain
      .map((anc) => anc.relations?.[relField])
      .filter((x): x is ModelNarrowing => x !== undefined);
    validatePathNarrowing(
      sub,
      childAncestorChain,
      ancestorDefaults,
      sameLayerDefaults,
      ancestorDefaultsEnums,
      sameLayerDefaultsEnums,
      maps,
      target.mapName,
      target.modelName,
      `${position}.relations.${relField}`,
      errors,
    );
  }
};

export const validateNarrowing = (narrowing: LensNarrowing): void => {
  const errors: string[] = [];
  const set = getRoot(narrowing);
  const ancestors = collectChain(narrowing.parent);

  for (const [mapName, mapNarrowing] of Object.entries(narrowing.maps)) {
    const fieldMap = set.maps[mapName];
    if (!fieldMap) {
      errors.push(`maps.${mapName}: not in lens`);
      continue;
    }

    const ancestorDefaultsEnums = ancestors
      .map((anc) => anc.maps[mapName]?.defaults?.enums)
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    // Validate defaults.models
    for (const [modelName, dflt] of Object.entries(mapNarrowing.defaults?.models ?? {})) {
      const model = fieldMap.models[modelName];
      if (!model) {
        errors.push(`maps.${mapName}.defaults.models.${modelName}: not in fieldMap`);
        continue;
      }
      const ancestorDefaultsForModel = ancestors
        .map((anc) => anc.maps[mapName]?.defaults?.models?.[modelName])
        .filter((x): x is ModelDefaultNarrowing => x !== undefined);
      validateModelNode(
        dflt,
        ancestorDefaultsForModel as ModelNarrowing[],
        undefined,
        model.fields,
        modelName,
        fieldMap.enums,
        `maps.${mapName}.defaults.models.${modelName}`,
        errors,
        true,
      );
      validateEnumFieldAgainstChain(
        model.fields,
        dflt,
        undefined,
        ancestorDefaultsEnums,
        `maps.${mapName}.defaults.models.${modelName}`,
        errors,
      );
    }

    // Validate defaults.enums
    if (mapNarrowing.defaults?.enums) {
      validateDefaultsEnums(
        mapName,
        mapNarrowing.defaults.enums,
        fieldMap.enums,
        ancestorDefaultsEnums,
        errors,
      );
    }

    // Validate path-specific models[*]
    const sameLayerDefaultsEnums = mapNarrowing.defaults?.enums;
    for (const [modelName, modelNarrowing] of Object.entries(mapNarrowing.models)) {
      const model = fieldMap.models[modelName];
      if (!model) {
        errors.push(`maps.${mapName}.models.${modelName}: not in fieldMap`);
        continue;
      }
      // Reject `where` at the top-level models[X] position — it's redundant.
      // For root-anchored scoping use `LensNarrowing.where`; for model-intrinsic
      // ("wherever X appears") use `defaults.models[X].where`. The `where` field
      // remains valid inside relations[R] for path-specific descent scoping.
      if (modelNarrowing.where !== undefined) {
        errors.push(
          `maps.${mapName}.models.${modelName}.where: not allowed at top-level. ` +
            `Use LensNarrowing.where for root scoping, or defaults.models.${modelName}.where ` +
            `for model-intrinsic scoping. (where on relations[R] still works for descent scoping.)`,
        );
      }
      const ancestorChainForModel = ancestors
        .map((anc) => anc.maps[mapName]?.models[modelName])
        .filter((x): x is ModelNarrowing => x !== undefined);
      const ancestorDefaultsForModel = ancestors
        .map((anc) => anc.maps[mapName]?.defaults?.models?.[modelName])
        .filter((x): x is ModelDefaultNarrowing => x !== undefined);
      const sameLayerDefaultsForModel = mapNarrowing.defaults?.models?.[modelName];
      validatePathNarrowing(
        modelNarrowing,
        ancestorChainForModel,
        ancestorDefaultsForModel,
        sameLayerDefaultsForModel,
        ancestorDefaultsEnums,
        sameLayerDefaultsEnums,
        set.maps,
        mapName,
        modelName,
        `maps.${mapName}.models.${modelName}`,
        errors,
      );
    }
  }

  if (narrowing.where !== undefined) {
    const check = checkRuleAgainstLens(narrowing.where, narrowing);
    for (const v of check.violations) {
      errors.push(`where: '${v.path}' ${v.reason}`);
    }
  }

  if (errors.length) {
    throw new Error(`validateNarrowing:\n${errors.join('\n')}`);
  }
};
