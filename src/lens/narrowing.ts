import { declaredEnumValues, isRelationEntry } from '../fieldMap/entry';
import type { FieldMap, FieldMapEntry } from '../fieldMap/types';
import { relationTargetOf } from '../fieldMap/walk.ts';
import { fieldOf, modelOf, own } from '../own';
import type { Condition } from '../types.ts';
import {
  throwIfInvalid,
  type ValidationIssue,
  type ValidationResult,
  validationResult,
} from '../validate';
import { validateBindNames } from './bindings.ts';
import { collectChain, getLensRoot } from './chain.ts';
import { toLensSelectWith } from './lensRows.ts';
import { narrowAt } from './narrowRule.ts';
import {
  allowedEnumValues,
  declaresModelSource,
  escapingGrantRef,
  grantRefs,
  hiddenHop,
  intersectStringSet,
  isSourceSpec,
  LensRefusal,
  misanchoredPath,
  normalizeGroupBy,
  normalizeSource,
  OFF_PATH,
  type Policy,
  relationHops,
  resolvePolicy,
  resolveVisit,
  type ShownVisit,
  shownVisits,
  sourceReadsVisible,
  undeclaredModelSource,
} from './policy.ts';
import { projectModelsWith } from './projectModels.ts';
import { lensVisitWith, projectPathsWith } from './projectPaths.ts';
import { sourcePlansWith } from './sourceOptions.ts';
import type {
  EnumNarrowing,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  SourceSpec,
} from './types.ts';
import { checkConditionAtVisit } from './validateRuleInLens.ts';

/** A visit of the PARENT surface a `where` is validated at: the where's own model, reached
 * at `relPath` (a declared path, `[]` for the anchor, or `OFF_PATH` for the model-intrinsic
 * visit a model default gets everywhere else). */
type WhereVisit = { mapName: string; modelName: string; relPath: readonly string[] };

// A where filters incoming rows, so its refs must resolve on the parent surface at the visit it
// is anchored to — never against this layer's own picks/omits, and never against a re-anchored
// lens: the policy keeps its real root so a bare `path` ref (the root row) is gated at
// the lens anchor while `field` and `$.` refs are gated at the visit. In the first narrowing it
// may cross any relation; in a later layer only what the parent exposes.
const validateWhere = (
  condition: Condition | undefined,
  parentPolicy: Policy,
  visits: readonly WhereVisit[],
  position: string,
  errors: ValidationIssue[],
): void => {
  if (condition === undefined) return;
  // A bare value path reads the root row: only the root grant stands on it.
  const refs = grantRefs(condition);
  const bare = position === 'root.where' ? null : refs.bare;
  if (bare !== null) {
    errors.push({
      path: position,
      code: 'invalid_value_source',
      message: misanchoredPath(bare).message,
    });
    return;
  }
  const { escaping } = refs;
  if (escaping !== null) {
    errors.push({
      path: position,
      code: 'scope_out_of_bounds',
      message: escapingGrantRef(escaping).message,
    });
    return;
  }
  const seen = new Set<string>();
  // The first narrowing's grants read the menu — any relation; a later layer's read only what its
  // parent exposes, or a delegate's `where` would probe what it can't see.
  const grant: Policy = { ...parentPolicy, grant: parentPolicy.chain.length === 0 };
  for (const { mapName, modelName, relPath } of visits) {
    for (const v of checkConditionAtVisit(condition, grant, mapName, modelName, relPath)) {
      // The gate's own code carries through: what is wrong, not only that something is.
      const message = `'${v.path}' ${v.message}`;
      if (seen.has(message)) continue;
      seen.add(message);
      errors.push({ path: position, code: v.code, message });
    }
  }
};

// A label or axis is client-visible option data: at every visit the node applies to, it may cross
// only relations the lens declares there, and read only what the layers after its earliest
// declaration show (`sourceReadsVisible`, the rule projectLens enforces). The declaring layer
// itself stays free to source a column it hides — visibility ≠ materialization within one layer.
const validateSourceTargetVisibility = (
  narrowing: ModelNarrowing | ModelDefaultNarrowing,
  current: LensNarrowing,
  parentPolicy: Policy,
  visits: readonly WhereVisit[],
  position: string,
  errors: ValidationIssue[],
): void => {
  const policy: Policy = { ...parentPolicy, chain: [...parentPolicy.chain, current] };
  const reported = new Set<string>();
  for (const at of visits) {
    const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
    for (const [field, entry] of Object.entries(narrowing.sources ?? {})) {
      const spec = normalizeSource(entry);
      for (const kind of ['label', 'groupBy'] as const) {
        if (spec[kind] === undefined || reported.has(`${field}|${kind}`)) continue;
        // The value in force is what's checked; only the node that set it is at fault.
        const declared = kind === 'label' ? spec.label : normalizeGroupBy(spec.groupBy);
        const inForce =
          kind === 'label' ? effect.sourceLabels.get(field) : effect.sourceGroupBys.get(field);
        if (JSON.stringify(declared) !== JSON.stringify(inForce)) continue;
        const paths = typeof inForce === 'string' ? [inForce] : (inForce ?? []);
        const off = paths.map((path) => hiddenHop(policy, at, path)).find((hop) => hop !== null);
        if (off) {
          reported.add(`${field}|${kind}`);
          errors.push({
            path: `${position}.sources.${field}`,
            code: 'invalid_source',
            message: `${kind} '${String(spec[kind])}' crosses '${off}', a relation the lens does not show there (not turned on, or omitted)`,
          });
          continue;
        }
        if (sourceReadsVisible(policy, effect, at, field, kind)) continue;
        reported.add(`${field}|${kind}`);
        errors.push({
          path: `${position}.sources.${field}`,
          code: 'invalid_source',
          message: `${kind} '${String(spec[kind])}' reads a column hidden by another layer`,
        });
      }
    }
  }
};

// A materialization path — a groupBy axis or a dotted label — descends to-one relations
// only and must land on a scalar/enum column. `kind` names it in the error.
const toOnePathError = (
  path: string,
  maps: Record<string, FieldMap>,
  mapName: string,
  modelName: string,
  kind: 'groupBy' | 'label',
): string | null => {
  const segments = path.split('.');
  const { hops } = relationHops(maps, { mapName, modelName, relPath: [] }, path);
  const toMany = hops.find((hop, i) => hop.isList && i < segments.length - 1);
  if (toMany) return `${kind} cannot traverse to-many relation '${segments[hops.indexOf(toMany)]}'`;
  if (hops.length === segments.length)
    return `${kind} must end on a scalar column, '${segments.at(-1)}' is a relation`;
  const at = hops.at(-1) ?? { map: mapName, model: modelName };
  const seg = segments[hops.length];
  const entry = fieldOf(own(maps, at.map), at.model, seg);
  if (!entry) return `${kind} segment '${seg}' not on model '${at.model}'`;
  if (isRelationEntry(entry)) return `${kind} relation '${seg}' has no resolvable target`;
  return hops.length === segments.length - 1 ? null : `${kind} segment '${seg}' is not a relation`;
};

// Why a field a layer names is already hidden: an ancestor's picks leave a column out or its omits
// drop the field, or a path node's own-layer defaults do. Picks never govern a relation.
const hiddenBy = (
  field: string,
  isRelation: boolean,
  ancestors: readonly ModelNarrowing[],
  defaults: ModelDefaultNarrowing | undefined,
): string | null => {
  for (const anc of ancestors) {
    if (!isRelation && anc.picks && !anc.picks.includes(field)) return "not in ancestor's picks";
    if (anc.omits?.includes(field)) return 'was omitted by ancestor';
  }
  if (!isRelation && defaults?.picks && !defaults.picks.includes(field))
    return 'not visible from defaults.picks';
  if (defaults?.omits?.includes(field)) return 'already excluded by defaults';
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
  errors: ValidationIssue[],
  parentPolicy: Policy,
  whereVisits: readonly WhereVisit[],
  isDefault = false,
): void => {
  // Picks name columns and omits may always name relations: only omitting a column beside picks
  // conflicts.
  const omitsColumn = narrowing.omits?.some((f) => {
    const entry = own(modelFields, f);
    return entry === undefined || !isRelationEntry(entry);
  });
  if (narrowing.picks && omitsColumn) {
    errors.push({
      path: `${position}`,
      code: 'conflicting_selection',
      message: `cannot specify both picks and omits of a column`,
    });
  }

  for (const kind of ['picks', 'omits'] as const)
    for (const f of narrowing[kind] ?? []) {
      const named = own(modelFields, f);
      if (!named) {
        errors.push({
          path: `${position}.${kind}`,
          code: 'not_in_lens',
          message: `field '${f}' not on model`,
        });
        continue;
      }
      const isRelation = isRelationEntry(named);
      if (isRelation && kind === 'picks') {
        errors.push({
          path: `${position}.picks`,
          code: 'wrong_kind',
          message: `'${f}' is a relation: picks names columns; turn a relation on with \`relations\``,
        });
        continue;
      }
      const hidden = hiddenBy(f, isRelation, ancestorChain, sameLayerDefaults);
      if (hidden)
        errors.push({
          path: `${position}.${kind}`,
          code: 'not_visible',
          message: `'${f}' ${hidden}`,
        });
    }

  const validateEnumOp = (
    op: 'enumPicks' | 'enumOmits',
    fieldName: string,
    values: readonly string[],
  ): void => {
    const fieldEntry = own(modelFields, fieldName);
    if (!fieldEntry) {
      errors.push({
        path: `${position}.${op}`,
        code: 'not_in_lens',
        message: `field '${fieldName}' not on model`,
      });
      return;
    }
    if (fieldEntry.kind !== 'enum') {
      errors.push({
        path: `${position}.${op}`,
        code: 'wrong_kind',
        message: `field '${fieldName}' is not an enum field`,
      });
      return;
    }
    const registry = declaredEnumValues(fieldEntry, enumRegistry);
    for (const v of values) {
      if (registry && !registry.includes(v)) {
        errors.push({
          path: `${position}.${op}.${fieldName}`,
          code: 'value_not_allowed',
          message: `'${v}' is not a known value of enum '${fieldEntry.type}'`,
        });
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
    const sourced = own(modelFields, field);
    if (!sourced) {
      errors.push({
        path: `${position}.sources`,
        code: 'not_in_lens',
        message: `field '${field}' not on model`,
      });
      continue;
    }
    if (isRelationEntry(sourced)) {
      errors.push({
        path: `${position}.sources.${field}`,
        code: 'wrong_kind',
        message: `'${field}' is a relation: a source offers a column's values`,
      });
      continue;
    }
    let spec: SourceSpec;
    try {
      spec = normalizeSource(entry);
    } catch (error) {
      if (!(error instanceof LensRefusal)) throw error;
      errors.push({
        path: `${position}.sources.${field}`,
        code: error.code,
        message: error.message,
      });
      continue;
    }
    // Read as stored data: `from` may hold anything.
    const from = (spec as { from?: unknown }).from;
    if (from !== undefined) {
      // A pointer offers the model's own source: it lives on a path, names mapDefaults, and
      // takes that source's label and axes.
      const problem =
        from !== 'mapDefaults'
          ? `from takes 'mapDefaults', not '${String(from)}'`
          : isDefault
            ? `a mapDefaults source is what a path source's from: 'mapDefaults' points at; it can't point itself`
            : (spec as { label?: unknown }).label !== undefined ||
                (spec as { groupBy?: unknown }).groupBy !== undefined
              ? `a from: 'mapDefaults' source takes the model source's label and groupBy`
              : null;
      if (problem)
        errors.push({
          path: `${position}.sources.${field}`,
          code: 'invalid_source',
          message: problem,
        });
    }
    const dottedLabel = spec.label?.includes('.') ? spec.label : undefined;
    if (spec.label !== undefined) {
      if (dottedLabel) {
        const err = toOnePathError(dottedLabel, maps, mapName, modelName, 'label');
        if (err)
          errors.push({
            path: `${position}.sources.${field}`,
            code: 'invalid_source',
            message: `${err}`,
          });
      } else {
        const labelEntry = own(modelFields, spec.label);
        if (!labelEntry)
          errors.push({
            path: `${position}.sources.${field}`,
            code: 'not_in_lens',
            message: `label column '${spec.label}' not on model`,
          });
        else if (isRelationEntry(labelEntry))
          errors.push({
            path: `${position}.sources.${field}`,
            code: 'wrong_kind',
            message: `label '${spec.label}' is a relation, not a column`,
          });
      }
    }
    const axes = normalizeGroupBy(spec.groupBy);
    // The sql compile aliases each axis column '__group_i' and a dotted label '__label' —
    // a source selecting a real column of that shape would clobber it in flat rows.
    if (axes !== undefined || dottedLabel !== undefined) {
      const reserved = /^__(group(_\d+)?|label)$/;
      if (reserved.test(field) || (spec.label !== undefined && reserved.test(spec.label))) {
        errors.push({
          path: `${position}.sources.${field}`,
          code: 'invalid_source',
          message: `'__group*' / '__label' names are reserved on grouped or path-labeled sources (sql column aliases)`,
        });
      }
    }
    if (axes !== undefined) {
      for (const axis of axes) {
        const err = toOnePathError(axis, maps, mapName, modelName, 'groupBy');
        if (err)
          errors.push({
            path: `${position}.sources.${field}`,
            code: 'invalid_source',
            message: `${err}`,
          });
      }
      // where/sources compose AND-only across layers; divergent axes would
      // silently re-partition an ancestor's option namespace — fail loud instead.
      const axesKey = JSON.stringify(axes);
      for (const anc of ancestorChain) {
        const ancEntry = own(anc.sources, field);
        if (ancEntry === undefined) continue;
        const ancAxes = normalizeGroupBy(normalizeSource(ancEntry).groupBy);
        if (ancAxes !== undefined && JSON.stringify(ancAxes) !== axesKey) {
          errors.push({
            path: `${position}.sources.${field}`,
            code: 'not_visible',
            message: `groupBy [${axes}] conflicts with an ancestor layer's groupBy [${ancAxes}]`,
          });
        }
      }
    }
    validateWhere(spec.where, parentPolicy, whereVisits, `${position}.sources.${field}`, errors);
  }
};

const validateDefaultsEnums = (
  mapName: string,
  defaultsEnums: Record<string, EnumNarrowing>,
  enumRegistry: Record<string, readonly string[]> | undefined,
  ancestorEnumNarrowings: Array<Record<string, EnumNarrowing>>,
  errors: ValidationIssue[],
): void => {
  for (const [enumName, enumN] of Object.entries(defaultsEnums)) {
    const registryVals = own(enumRegistry, enumName);
    if (!registryVals) {
      errors.push({
        path: `mapDefaults.${mapName}.enums.${enumName}`,
        code: 'not_in_lens',
        message: `enum not in registry`,
      });
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
        errors.push({
          path: `mapDefaults.${mapName}.enums.${enumName}.picks`,
          code: 'value_not_allowed',
          message: `'${v}' not a known value`,
        });
      } else if (!isInheritedVisible(v)) {
        errors.push({
          path: `mapDefaults.${mapName}.enums.${enumName}.picks`,
          code: 'not_visible',
          message: `'${v}' not visible from ancestors`,
        });
      }
    }
    for (const v of enumN.omits ?? []) {
      if (!registryVals.includes(v)) {
        errors.push({
          path: `mapDefaults.${mapName}.enums.${enumName}.omits`,
          code: 'value_not_allowed',
          message: `'${v}' not a known value`,
        });
      } else if (!isInheritedVisible(v)) {
        errors.push({
          path: `mapDefaults.${mapName}.enums.${enumName}.omits`,
          code: 'not_visible',
          message: `'${v}' already excluded by ancestors`,
        });
      }
    }
  }
};

// A layer's enumPicks / enumOmits name only values its inheritance still shows — the allowed
// set resolveVisit folds at the visit from `inherited` (the layers above, and for a path node this
// layer's own defaults). A value the enum doesn't declare is validateEnumOp's to report.
const validateEnumInheritance = (
  narrowing: ModelDefaultNarrowing | ModelNarrowing,
  inherited: Policy,
  at: WhereVisit,
  modelFields: Record<string, FieldMapEntry>,
  enumRegistry: Record<string, readonly string[]> | undefined,
  position: string,
  errors: ValidationIssue[],
): void => {
  const effect = resolveVisit(inherited, at.mapName, at.modelName, at.relPath);
  for (const op of ['enumPicks', 'enumOmits'] as const)
    for (const [field, values] of Object.entries(narrowing[op] ?? {})) {
      const entry = own(modelFields, field);
      if (entry?.kind !== 'enum') continue;
      const declared = declaredEnumValues(entry, enumRegistry) ?? [];
      const allowed = allowedEnumValues(effect, field) ?? declared;
      for (const v of values)
        if (declared.includes(v) && !allowed.includes(v))
          errors.push({
            path: `${position}.${op}.${field}`,
            code: 'not_visible',
            message: `'${v}' is not visible (not allowed by the inherited enum narrowing)`,
          });
    }
};

// Where a node applies: the parent's visits it narrows (its `where` resolves there, and a relation it
// names must be shown there), the composed lens's visits (where its labels and axes are shown), and
// whether it is a model default (its `where` resolves at the model-intrinsic visit too).
type NodeVisits = { parent: WhereVisit[]; composed: WhereVisit[]; isDefault: boolean };

const across = (visits: readonly WhereVisit[], relation: string, target: string, map: string) =>
  visits.map((v) => ({ mapName: map, modelName: target, relPath: [...v.relPath, relation] }));

const validateNode = (
  narrowing: ModelNarrowing,
  ancestorChain: ModelNarrowing[],
  current: LensNarrowing,
  chain: LensNarrowing[],
  maps: Record<string, FieldMap>,
  mapName: string,
  modelName: string,
  position: string,
  errors: ValidationIssue[],
  parentPolicy: Policy,
  visits: NodeVisits,
): void => {
  const fieldMap = own(maps, mapName);
  const model = modelOf(fieldMap, modelName);
  if (!model) return;
  const isFirst = chain.length === 0;
  // The lens this layer composes, its grants not yet vetted: where they apply.
  const unvetted: Policy = {
    ...parentPolicy,
    chain: [...parentPolicy.chain, current],
    unvetted: true,
  };

  const sameLayerDefaultsForModel = visits.isDefault
    ? undefined
    : own(own(current.mapDefaults, mapName)?.models, modelName);
  const ancestorDefaultsForModel = chain
    .map((a) => own(own(a.mapDefaults, mapName)?.models, modelName))
    .filter((x): x is ModelDefaultNarrowing => x !== undefined);
  const synthAncestors = [...ancestorDefaultsForModel, ...ancestorChain];
  const intrinsic = { mapName, modelName, relPath: OFF_PATH };

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
    // The first narrowing's grants read the menu, at every visit including the model's own; a
    // later layer's are checked where they apply — the visits the lens it composes shows.
    isFirst ? (visits.isDefault ? [intrinsic, ...visits.parent] : visits.parent) : visits.composed,
    visits.isDefault,
  );

  validateEnumInheritance(
    narrowing,
    visits.isDefault
      ? parentPolicy
      : {
          ...parentPolicy,
          chain: [
            ...parentPolicy.chain,
            { parent: current.parent, mapDefaults: current.mapDefaults },
          ],
          unvetted: true,
        },
    visits.isDefault ? intrinsic : (visits.parent[0] ?? intrinsic),
    model.fields,
    fieldMap?.enums,
    position,
    errors,
  );

  validateSourceTargetVisibility(
    narrowing,
    current,
    parentPolicy,
    visits.composed,
    position,
    errors,
  );

  // A path source that offers its model's own source needs one declared in some layer.
  const composed: Policy = { ...parentPolicy, chain: [...parentPolicy.chain, current] };
  if (!visits.isDefault)
    for (const [field, entry] of Object.entries(narrowing.sources ?? {})) {
      if (!isSourceSpec(entry) || entry.from !== 'mapDefaults') continue;
      if (!declaresModelSource(composed, mapName, modelName, field))
        errors.push({
          path: `${position}.sources.${field}`,
          code: 'invalid_source',
          message: undeclaredModelSource(
            [getLensRoot(current).model, ...(visits.parent[0]?.relPath ?? [])].join('.'),
            mapName,
            modelName,
            field,
          ).message,
        });
    }

  for (const [relField, sub] of Object.entries(narrowing.relations ?? {})) {
    const entry = own(model.fields, relField);
    if (!entry) {
      errors.push({
        path: `${position}.relations`,
        code: 'not_in_lens',
        message: `'${relField}' not on model`,
      });
      continue;
    }
    if (!isRelationEntry(entry)) {
      errors.push({
        path: `${position}.relations`,
        code: 'wrong_kind',
        message: `'${relField}' is not a relation (kind=${entry.kind})`,
      });
      continue;
    }
    // The base lens is the menu: the first narrowing may turn any relation on. A later layer
    // narrows only what its parent shows — on a model default, wherever the parent visits it.
    // A path node's relation must be shown at its visit; a model default's at one or more of the
    // model's visits (where the tree doesn't cross it, restating it narrows nothing).
    const shown = (v: WhereVisit) =>
      resolveVisit(parentPolicy, v.mapName, v.modelName, v.relPath).relations.has(relField);
    const shownComposed = (v: WhereVisit) =>
      resolveVisit(unvetted, v.mapName, v.modelName, v.relPath).relations.has(relField);
    if (!isFirst && !(visits.isDefault ? visits.parent.some(shown) : visits.parent.every(shown))) {
      errors.push({
        path: `${position}.relations`,
        code: 'not_visible',
        message: `'${relField}' is not shown by the parent${visits.isDefault ? ` wherever ${modelName} is visited` : ''}: only the first narrowing over the base lens turns a relation on`,
      });
      continue;
    }
    const target = relationTargetOf(entry, mapName);
    if (!target) continue;
    if (!modelOf(own(maps, target.mapName), target.modelName)) {
      errors.push({
        path: `${position}.relations.${relField}`,
        code: 'not_in_lens',
        message: `target model not found in lens`,
      });
      continue;
    }
    const childAncestorChain = ancestorChain
      .map((anc) => own(anc.relations, relField))
      .filter((x): x is ModelNarrowing => x !== undefined);
    validateNode(
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
      {
        parent: across(
          visits.isDefault ? visits.parent.filter(shown) : visits.parent,
          relField,
          target.modelName,
          target.mapName,
        ),
        composed: across(
          visits.composed.filter(shownComposed),
          relField,
          target.modelName,
          target.mapName,
        ),
        isDefault: visits.isDefault,
      },
    );
  }
};

/** A narrowing layer checked against the layers above it: it names only what they still show —
 *  a relation it turns on or narrows included, unless it is the first narrowing over the base
 *  lens — and only narrows. `picks` names columns only. Each problem is an issue with a code
 *  (`not_in_lens`, `not_visible`, `conflicting_selection`, `wrong_kind`, `value_not_allowed`,
 *  `invalid_source`, `invalid_binding`, or the lens gate's for a `where`). */
export const validateNarrowing = (narrowing: LensNarrowing): ValidationResult => {
  const errors: ValidationIssue[] = [];
  try {
    collectNarrowingIssues(narrowing, errors);
  } catch (error) {
    // A grant the runtime refuses (reported above, or by an ancestor's layer) ends the check.
    if (!(error instanceof LensRefusal)) throw error;
    if (!errors.some((issue) => issue.code === error.code))
      errors.push({ path: '', code: error.code, message: error.message });
  }
  return validationResult(errors);
};

const collectNarrowingIssues = (narrowing: LensNarrowing, errors: ValidationIssue[]): void => {
  const set = getLensRoot(narrowing);
  const ancestors = collectChain(narrowing.parent);
  const parentPolicy = resolvePolicy(narrowing.parent);
  const parentVisits = shownVisits(parentPolicy);
  // The visits this layer's model defaults apply at on the lens it composes.
  // A grant the runtime refuses stops only the part of the check that applies it; the rest runs.
  const refusals: LensRefusal[] = [];
  const guarded = (check: () => void): void => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof LensRefusal)) throw error;
      refusals.push(error);
    }
  };
  let composed: ShownVisit[] | null = null;
  const composedVisits = (): ShownVisit[] => {
    composed ??= shownVisits({
      ...parentPolicy,
      chain: [...parentPolicy.chain, narrowing],
      unvetted: true,
    });
    return composed;
  };

  for (const [mapName, defaults] of Object.entries(narrowing.mapDefaults ?? {})) {
    const fieldMap = own(set.maps, mapName);
    if (!fieldMap) {
      errors.push({ path: `mapDefaults.${mapName}`, code: 'not_in_lens', message: `not in lens` });
      continue;
    }

    const ancestorDefaultsEnums = ancestors
      .map((anc) => own(anc.mapDefaults, mapName)?.enums)
      .filter((x): x is NonNullable<typeof x> => x !== undefined);

    for (const [modelName, dflt] of Object.entries(defaults.models ?? {})) {
      const model = modelOf(fieldMap, modelName);
      if (!model) {
        errors.push({
          path: `mapDefaults.${mapName}.models.${modelName}`,
          code: 'not_in_lens',
          message: `not in fieldMap`,
        });
        continue;
      }
      const ancestorDefaultsForModel = ancestors
        .map((anc) => own(own(anc.mapDefaults, mapName)?.models, modelName))
        .filter((x): x is ModelDefaultNarrowing => x !== undefined);
      // A model default applies at EVERY visit of the model: the model-intrinsic (off-path)
      // visit plus each visit of it the parent shows; its labels show at the composed lens's.
      const of = (visits: readonly ShownVisit[]) =>
        visits
          .map(({ at }) => at)
          .filter((at) => at.mapName === mapName && at.modelName === modelName);
      let composedOfModel: WhereVisit[] = [];
      guarded(() => {
        composedOfModel = of(composedVisits());
      });
      guarded(() =>
        validateNode(
          dflt,
          ancestorDefaultsForModel,
          narrowing,
          ancestors,
          set.maps,
          mapName,
          modelName,
          `mapDefaults.${mapName}.models.${modelName}`,
          errors,
          parentPolicy,
          { parent: of(parentVisits), composed: composedOfModel, isDefault: true },
        ),
      );
    }

    if (defaults.enums) {
      validateDefaultsEnums(mapName, defaults.enums, fieldMap.enums, ancestorDefaultsEnums, errors);
    }
  }

  if (narrowing.root) {
    const lensMapName = set.mapName;
    const lensModel = set.model;
    const fieldMap = own(set.maps, lensMapName);
    if (!fieldMap) {
      errors.push({
        path: `root`,
        code: 'not_in_lens',
        message: `lens map '${lensMapName}' not in lens`,
      });
    } else if (!modelOf(fieldMap, lensModel)) {
      errors.push({
        path: `root`,
        code: 'not_in_lens',
        message: `lens model '${lensModel}' not in fieldMap`,
      });
    } else {
      const ancestorChainForRoot = ancestors
        .map((anc) => anc.root)
        .filter((x): x is ModelNarrowing => x !== undefined);
      const anchor = { mapName: lensMapName, modelName: lensModel, relPath: [] };
      guarded(() =>
        validateNode(
          narrowing.root as ModelNarrowing,
          ancestorChainForRoot,
          narrowing,
          ancestors,
          set.maps,
          lensMapName,
          lensModel,
          'root',
          errors,
          parentPolicy,
          { parent: [anchor], composed: [anchor], isDefault: false },
        ),
      );
    }
  }

  for (const message of validateBindNames(narrowing))
    errors.push({ path: 'bindings', code: 'invalid_binding', message });
  // The postures, run as the runtime runs them, their refusals collected: the projection by path
  // and by model, a visit at each shown path, the source plans, the fetch select, and a rule
  // reaching each shown visit narrowed. Nothing compiles, so no binding, clock or literal is read.
  const inspect: Policy = {
    ...parentPolicy,
    chain: [...parentPolicy.chain, narrowing],
    inspect: true,
  };
  guarded(() => sourcePlansWith(inspect, projectPathsWith(inspect)));
  guarded(() => projectModelsWith(inspect));
  guarded(() => toLensSelectWith(inspect));
  guarded(() => {
    const shown = new Map<string, WhereVisit>();
    for (const { at } of composedVisits()) {
      shown.set(at.relPath.join('.'), at);
      guarded(() => lensVisitWith(inspect, at.relPath.join('.')));
      // A rule reaching the visit from the one above: its grants injected as a rule's are — re-rooted
      // across a to-one relation, into the array condition across a to-many one.
      const relation = at.relPath.at(-1);
      const from = shown.get(at.relPath.slice(0, -1).join('.'));
      if (relation === undefined || !from) continue;
      const entry = fieldOf(own(set.maps, from.mapName), from.modelName, relation);
      const reach: Condition = entry?.isList
        ? ({ field: relation, arrayOperator: 'any', condition: true } as Condition)
        : { field: relation, operator: 'exists' };
      guarded(() => narrowAt(reach, inspect, from));
    }
  });
  for (const refusal of refusals)
    if (!errors.some((issue) => refusal.message.includes(issue.message)))
      errors.push({ path: '', code: refusal.code, message: refusal.message });
};

/** `validateNarrowing`, throwing its issues. */
export const assertValidNarrowing = (narrowing: LensNarrowing): void =>
  throwIfInvalid(validateNarrowing(narrowing), 'validateNarrowing');
