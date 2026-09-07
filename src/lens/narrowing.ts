import { own } from '../own';
import type { FieldMap, FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { validateBindNames } from './bindings.ts';
import { checkConditionAtVisit } from './checkRule.ts';
import {
  augmentPicksWithRelations,
  intersectStringSet,
  normalizeGroupBy,
  normalizeSource,
  OFF_PATH,
  type Policy,
  resolvePolicy,
} from './policy.ts';
import { projectByPath } from './projectByPath.ts';
import type { LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

/** A visit of the PARENT surface a `where` is validated at: the where's own model, reached
 * at `relPath` (a declared path, `[]` for the anchor, or `OFF_PATH` for the model-intrinsic
 * visit a model default gets everywhere else). */
type WhereVisit = { mapName: string; modelName: string; relPath: readonly string[] };

// A where filters incoming rows, so its refs must resolve on the parent surface at the visit it
// is anchored to — never against this layer's own picks/omits, and never against a re-anchored
// lens: the policy keeps its real root so a bare `path` ref (check()'s root context) is gated at
// the lens anchor while `field` and `$.` refs are gated at the visit.
const validateWhere = (
  condition: Condition | undefined,
  parentPolicy: Policy,
  visits: readonly WhereVisit[],
  position: string,
  errors: string[],
): void => {
  if (condition === undefined) return;
  const seen = new Set<string>();
  for (const { mapName, modelName, relPath } of visits) {
    for (const v of checkConditionAtVisit(condition, parentPolicy, mapName, modelName, relPath)) {
      const message = `${position}: '${v.path}' ${v.reason}`;
      if (seen.has(message)) continue;
      seen.add(message);
      errors.push(message);
    }
  }
};

// A parent layer's removals bind descendant materialization targets: group keys and
// label columns are client-visible option data, so a child source may not reference
// what an ancestor removed. The declaring layer itself stays free — visibility ≠
// materialization within one layer.
const ancestorRemoval = (
  name: string,
  ancestorNodes: readonly (ModelNarrowing | ModelDefaultNarrowing)[],
): string | null => {
  for (const anc of ancestorNodes) {
    const augmented = augmentPicksWithRelations(anc);
    if (augmented && !augmented.includes(name)) return "is not in an ancestor layer's picks";
    if (anc.omits?.includes(name)) return 'was omitted by an ancestor layer';
  }
  return null;
};

const validateSourceTargetVisibility = (
  narrowing: ModelNarrowing | ModelDefaultNarrowing,
  ancestorChain: readonly ModelNarrowing[],
  ancestorLayers: readonly LensNarrowing[],
  maps: Record<string, FieldMap>,
  mapName: string,
  modelName: string,
  position: string,
  errors: string[],
): void => {
  const defaultsFor = (map: string, model: string): ModelDefaultNarrowing[] =>
    ancestorLayers
      .map((layer) => layer.mapDefaults?.[map]?.models?.[model])
      .filter((x): x is ModelDefaultNarrowing => x !== undefined);

  for (const [field, entry] of Object.entries(narrowing.sources ?? {})) {
    const spec = normalizeSource(entry);

    // An ancestor that declared the same target for this field already authorized
    // materializing those values — re-declaring it is inherited authority, not a
    // new reference past the ancestor's removals.
    const ancestorSpecs = [...ancestorChain, ...defaultsFor(mapName, modelName)]
      .map((n) => n.sources?.[field])
      .filter((x): x is NonNullable<typeof x> => x !== undefined)
      .map(normalizeSource);

    if (spec.label !== undefined && !ancestorSpecs.some((s) => s.label === spec.label)) {
      const removed = ancestorRemoval(spec.label, [
        ...ancestorChain,
        ...defaultsFor(mapName, modelName),
      ]);
      if (removed)
        errors.push(`${position}.sources.${field}: label column '${spec.label}' ${removed}`);
    }

    const axes = normalizeGroupBy(spec.groupBy);
    if (axes === undefined) continue;
    const axesKey = JSON.stringify(axes);
    if (ancestorSpecs.some((s) => JSON.stringify(normalizeGroupBy(s.groupBy)) === axesKey)) {
      continue;
    }
    for (const axis of axes) {
      const segments = axis.split('.');
      let nodes: readonly (ModelNarrowing | ModelDefaultNarrowing)[] = ancestorChain;
      let curMap = mapName;
      let curModel = modelName;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const removed = ancestorRemoval(seg, [...nodes, ...defaultsFor(curMap, curModel)]);
        if (removed) {
          errors.push(`${position}.sources.${field}: groupBy segment '${seg}' ${removed}`);
          break;
        }
        if (i === segments.length - 1) break;
        const fieldEntry = own(maps[curMap]?.models[curModel]?.fields, seg);
        const target = fieldEntry ? resolveRelationTarget(fieldEntry, curMap) : null;
        if (!target) break; // path resolvability is validated by groupByPathError
        nodes = nodes
          .map((n) => ('relations' in n ? n.relations?.[seg] : undefined))
          .filter((x): x is ModelNarrowing => x !== undefined);
        curMap = target.mapName;
        curModel = target.modelName;
      }
    }
  }
};

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
    const entry = own(maps[curMap]?.models[curModel]?.fields, segments[i]);
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
  parentPolicy: Policy,
  whereVisits: readonly WhereVisit[],
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

  validateWhere(narrowing.where, parentPolicy, whereVisits, `${position}.where`, errors);

  for (const [field, entry] of Object.entries(narrowing.sources ?? {})) {
    if (!modelFields[field]) {
      errors.push(`${position}.sources: field '${field}' not on model`);
      continue;
    }
    const spec = normalizeSource(entry);
    if (spec.label !== undefined && !modelFields[spec.label]) {
      errors.push(`${position}.sources.${field}: label column '${spec.label}' not on model`);
    }
    const axes = normalizeGroupBy(spec.groupBy);
    if (axes !== undefined) {
      for (const axis of axes) {
        const err = groupByPathError(axis, maps, mapName, modelName);
        if (err) errors.push(`${position}.sources.${field}: ${err}`);
      }
      // The sql compile aliases each axis column '__group_i' — a grouped source
      // selecting a real column of that shape would clobber it in flat rows.
      const reserved = /^__group(_\d+)?$/;
      if (reserved.test(field) || (spec.label !== undefined && reserved.test(spec.label))) {
        errors.push(
          `${position}.sources.${field}: '__group*' names are reserved on grouped sources (sql group aliases)`,
        );
      }
      // where/sources compose AND-only across layers; divergent axes would
      // silently re-partition an ancestor's option namespace — fail loud instead.
      const axesKey = JSON.stringify(axes);
      for (const anc of ancestorChain) {
        const ancEntry = anc.sources?.[field];
        if (ancEntry === undefined) continue;
        const ancAxes = normalizeGroupBy(normalizeSource(ancEntry).groupBy);
        if (ancAxes !== undefined && JSON.stringify(ancAxes) !== axesKey) {
          errors.push(
            `${position}.sources.${field}: groupBy [${axes}] conflicts with an ancestor layer's groupBy [${ancAxes}]`,
          );
        }
      }
    }
    validateWhere(spec.where, parentPolicy, whereVisits, `${position}.sources.${field}`, errors);
  }
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
    const entry = own(modelFields, fieldName);
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
  parentPolicy: Policy,
  relPath: readonly string[],
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
    parentPolicy,
    [{ mapName, modelName, relPath }],
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

  validateSourceTargetVisibility(
    narrowing,
    ancestorChain,
    chain,
    maps,
    mapName,
    modelName,
    position,
    errors,
  );

  for (const [relField, sub] of Object.entries(narrowing.relations ?? {})) {
    const entry = own(model.fields, relField);
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
      parentPolicy,
      [...relPath, relField],
    );
  }
};

export const validateNarrowing = (narrowing: LensNarrowing): void => {
  const errors: string[] = [];
  const set = getRoot(narrowing);
  const ancestors = collectChain(narrowing.parent);
  const parentPolicy = resolvePolicy(narrowing.parent);
  const parentVisits = projectByPath(narrowing.parent);

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
      // A model default applies at EVERY visit of the model: the model-intrinsic (off-path)
      // visit plus each path the parent declares for it, so its where must resolve at all.
      const whereVisits: WhereVisit[] = [{ mapName, modelName, relPath: OFF_PATH }];
      for (const [path, visit] of parentVisits) {
        if (visit.mapName === mapName && visit.modelName === modelName) {
          whereVisits.push({ mapName, modelName, relPath: path.split('.').slice(1) });
        }
      }
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
        parentPolicy,
        whereVisits,
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
      validateSourceTargetVisibility(
        dflt,
        [],
        ancestors,
        set.maps,
        mapName,
        modelName,
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
        parentPolicy,
        [],
      );
    }
  }

  for (const e of validateBindNames(narrowing)) errors.push(e);

  if (errors.length) {
    throw new Error(`validateNarrowing:\n${errors.join('\n')}`);
  }
};
