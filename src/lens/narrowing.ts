import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import { validateBindNames } from './bindings.ts';
import { checkRuleAgainstLens } from './checkRule.ts';
import { intersectStringSet, normalizeSource } from './policy.ts';
import type { LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

// A groupBy path descends to-one relations only and must land on a scalar/enum column.
const groupByPathError = (
  groupBy: string,
  maps: Record<string, FieldMap>,
  mapName: string,
  modelName: string,
): string | null => {
  const segments = groupBy.split('.');
  let curMap = mapName;
  let curModel = modelName;
  for (let i = 0; i < segments.length; i++) {
    const entry = maps[curMap]?.models[curModel]?.fields[segments[i]];
    if (!entry) return `groupBy segment '${segments[i]}' not on model '${curModel}'`;
    const isLast = i === segments.length - 1;
    if (entry.kind === 'object' || entry.kind === 'bridge') {
      if (isLast) return `groupBy must end on a scalar column, '${segments[i]}' is a relation`;
      if (entry.isList) return `groupBy cannot traverse to-many relation '${segments[i]}'`;
      const target = resolveRelationTarget(entry, curMap);
      if (!target) return `groupBy relation '${segments[i]}' has no resolvable target`;
      curMap = target.mapName;
      curModel = target.modelName;
      continue;
    }
    if (!isLast) return `groupBy segment '${segments[i]}' is not a relation`;
  }
  return null;
};

const validateModelNode = (
  narrowing: ModelNarrowing | ModelDefaultNarrowing,
  ancestorChain: ModelNarrowing[],
  sameLayerDefaults: ModelDefaultNarrowing | undefined,
  maps: Record<string, FieldMap>,
  mapName: string,
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

  if (narrowing.where !== undefined && narrowing.where !== true && narrowing.where !== false) {
    const result = checkWhereAgainstModel(narrowing.where, modelFields, modelName);
    for (const err of result) errors.push(`${position}.where: ${err}`);
  }

  for (const [field, entry] of Object.entries(narrowing.sources ?? {})) {
    if (!modelFields[field]) {
      errors.push(`${position}.sources: field '${field}' not on model`);
      continue;
    }
    const spec = normalizeSource(entry);
    if (spec.label !== undefined && !modelFields[spec.label]) {
      errors.push(`${position}.sources.${field}: label column '${spec.label}' not on model`);
    }
    if (spec.groupBy !== undefined) {
      const err = groupByPathError(spec.groupBy, maps, mapName, modelName);
      if (err) errors.push(`${position}.sources.${field}: ${err}`);
    }
    const where = spec.where;
    if (where !== undefined && where !== true && where !== false) {
      const result = checkWhereAgainstModel(where, modelFields, modelName);
      for (const err of result) errors.push(`${position}.sources.${field}: ${err}`);
    }
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
      errors.push(`mapDefaults.${mapName}.enums.${enumName}: enum not in registry`);
      continue;
    }
    let inheritedPicks: Set<string> | null = null;
    const inheritedOmits = new Set<string>();
    for (const anc of ancestorEnumNarrowings) {
      const a = anc[enumName];
      if (!a) continue;
      if (a.picks) inheritedPicks = intersectStringSet(inheritedPicks, a.picks);
      if (a.omits) for (const v of a.omits) inheritedOmits.add(v);
    }
    const isInheritedVisible = (v: string): boolean => {
      if (inheritedOmits.has(v)) return false;
      if (inheritedPicks && !inheritedPicks.has(v)) return false;
      return true;
    };
    for (const v of enumN.picks ?? []) {
      if (!registryVals.includes(v)) {
        errors.push(`mapDefaults.${mapName}.enums.${enumName}.picks: '${v}' not a known value`);
      } else if (!isInheritedVisible(v)) {
        errors.push(
          `mapDefaults.${mapName}.enums.${enumName}.picks: '${v}' not visible from ancestors`,
        );
      }
    }
    for (const v of enumN.omits ?? []) {
      if (!registryVals.includes(v)) {
        errors.push(`mapDefaults.${mapName}.enums.${enumName}.omits: '${v}' not a known value`);
      } else if (!isInheritedVisible(v)) {
        errors.push(
          `mapDefaults.${mapName}.enums.${enumName}.omits: '${v}' already excluded by ancestors`,
        );
      }
    }
  }
};

const validateEnumFieldAgainstChain = (
  modelFields: Record<string, FieldMapEntry>,
  narrowing: ModelDefaultNarrowing | ModelNarrowing,
  sameLayerDefaultsEnums:
    | Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
    | undefined,
  ancestorDefaultsEnums: Array<
    Record<string, { picks?: readonly string[]; omits?: readonly string[] }>
  >,
  sameLayerDefaultsForModel: ModelDefaultNarrowing | undefined,
  ancestorDefaultsForModel: ModelDefaultNarrowing[],
  ancestorChainAtSamePosition: ModelNarrowing[],
  position: string,
  errors: string[],
): void => {
  const check = (
    op: 'enumPicks' | 'enumOmits',
    fieldName: string,
    values: readonly string[],
  ): void => {
    const entry = modelFields[fieldName];
    if (!entry || entry.kind !== 'enum') return;
    const enumType = entry.type;

    const state: { picks: Set<string> | null; omits: Set<string> } = {
      picks: null,
      omits: new Set(),
    };
    const addPicks = (vals: readonly string[]): void => {
      state.picks = intersectStringSet(state.picks, vals);
    };
    const addOmits = (vals: readonly string[]): void => {
      for (const v of vals) state.omits.add(v);
    };

    const typeLayers = [...ancestorDefaultsEnums];
    if (sameLayerDefaultsEnums) typeLayers.push(sameLayerDefaultsEnums);
    for (const layer of typeLayers) {
      const e = layer[enumType];
      if (!e) continue;
      if (e.picks) addPicks(e.picks);
      if (e.omits) addOmits(e.omits);
    }

    const modelLayers = [...ancestorDefaultsForModel];
    if (sameLayerDefaultsForModel) modelLayers.push(sameLayerDefaultsForModel);
    for (const dflt of modelLayers) {
      const p = dflt.enumPicks?.[fieldName];
      const o = dflt.enumOmits?.[fieldName];
      if (p) addPicks(p);
      if (o) addOmits(o);
    }

    for (const anc of ancestorChainAtSamePosition) {
      const p = anc.enumPicks?.[fieldName];
      const o = anc.enumOmits?.[fieldName];
      if (p) addPicks(p);
      if (o) addOmits(o);
    }

    for (const v of values) {
      if (state.omits.has(v)) {
        errors.push(
          `${position}.${op}.${fieldName}: '${v}' already excluded by inherited enum narrowing`,
        );
      } else if (state.picks && !state.picks.has(v)) {
        errors.push(
          `${position}.${op}.${fieldName}: '${v}' not allowed by inherited enum narrowing`,
        );
      }
    }
  };
  for (const [f, vals] of Object.entries(narrowing.enumPicks ?? {})) check('enumPicks', f, vals);
  for (const [f, vals] of Object.entries(narrowing.enumOmits ?? {})) check('enumOmits', f, vals);
};

type TypeEnumMap = Record<string, { picks?: readonly string[]; omits?: readonly string[] }>;

const validatePathNarrowing = (
  narrowing: ModelNarrowing,
  ancestorChain: ModelNarrowing[],
  current: LensNarrowing,
  chain: LensNarrowing[],
  maps: Record<string, FieldMap>,
  mapName: string,
  modelName: string,
  position: string,
  errors: string[],
): void => {
  const fieldMap = maps[mapName];
  const model = fieldMap?.models[modelName];
  if (!model) return;

  const sameLayerDefaultsForModel = current.mapDefaults?.[mapName]?.models?.[modelName];
  const ancestorDefaultsForModel = chain
    .map((a) => a.mapDefaults?.[mapName]?.models?.[modelName])
    .filter((x): x is ModelDefaultNarrowing => x !== undefined);
  const sameLayerDefaultsEnums: TypeEnumMap | undefined = current.mapDefaults?.[mapName]?.enums;
  const ancestorDefaultsEnums: TypeEnumMap[] = chain
    .map((a) => a.mapDefaults?.[mapName]?.enums)
    .filter((x): x is TypeEnumMap => x !== undefined);

  const synthAncestors = [
    ...ancestorDefaultsForModel.map((d) => d as ModelNarrowing),
    ...ancestorChain,
  ];

  validateModelNode(
    narrowing,
    synthAncestors,
    sameLayerDefaultsForModel,
    maps,
    mapName,
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
    sameLayerDefaultsForModel,
    ancestorDefaultsForModel,
    ancestorChain,
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
      current,
      chain,
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

  for (const [mapName, defaults] of Object.entries(narrowing.mapDefaults ?? {})) {
    const fieldMap = set.maps[mapName];
    if (!fieldMap) {
      errors.push(`mapDefaults.${mapName}: not in lens`);
      continue;
    }

    const ancestorDefaultsEnums = ancestors
      .map((anc) => anc.mapDefaults?.[mapName]?.enums)
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    for (const [modelName, dflt] of Object.entries(defaults.models ?? {})) {
      const model = fieldMap.models[modelName];
      if (!model) {
        errors.push(`mapDefaults.${mapName}.models.${modelName}: not in fieldMap`);
        continue;
      }
      const ancestorDefaultsForModel = ancestors
        .map((anc) => anc.mapDefaults?.[mapName]?.models?.[modelName])
        .filter((x): x is ModelDefaultNarrowing => x !== undefined);
      validateModelNode(
        dflt,
        ancestorDefaultsForModel as ModelNarrowing[],
        undefined,
        set.maps,
        mapName,
        model.fields,
        modelName,
        fieldMap.enums,
        `mapDefaults.${mapName}.models.${modelName}`,
        errors,
        true,
      );
      validateEnumFieldAgainstChain(
        model.fields,
        dflt,
        undefined,
        ancestorDefaultsEnums,
        undefined,
        ancestorDefaultsForModel,
        [],
        `mapDefaults.${mapName}.models.${modelName}`,
        errors,
      );
    }

    if (defaults.enums) {
      validateDefaultsEnums(mapName, defaults.enums, fieldMap.enums, ancestorDefaultsEnums, errors);
    }
  }

  if (narrowing.root) {
    const lensMapName = set.mapName;
    const lensModel = set.model;
    const fieldMap = set.maps[lensMapName];
    if (!fieldMap) {
      errors.push(`root: lens map '${lensMapName}' not in lens`);
    } else if (!fieldMap.models[lensModel]) {
      errors.push(`root: lens model '${lensModel}' not in fieldMap`);
    } else {
      const ancestorChainForRoot = ancestors
        .map((anc) => anc.root)
        .filter((x): x is ModelNarrowing => x !== undefined);
      validatePathNarrowing(
        narrowing.root,
        ancestorChainForRoot,
        narrowing,
        ancestors,
        set.maps,
        lensMapName,
        lensModel,
        'root',
        errors,
      );
    }
  }

  if (narrowing.root?.where !== undefined) {
    // where filters incoming rows → validate against the parent surface, not this layer's own picks
    const check = checkRuleAgainstLens(narrowing.root.where, narrowing.parent);
    for (const v of check.violations) {
      errors.push(`root.where: '${v.path}' ${v.reason}`);
    }
  }

  for (const e of validateBindNames(narrowing)) errors.push(e);

  if (errors.length) {
    throw new Error(`validateNarrowing:\n${errors.join('\n')}`);
  }
};
