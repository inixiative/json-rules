// One-stop resolver: given a lens/narrowing chain + a model visit (mapName,
// modelName, path of relation names from root), returns the effective
// narrowing facts at that visit. Used by checkRuleAgainstLens, applyLens,
// and validateNarrowing so each visitor doesn't reimplement composition.

import type { FieldMap } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import type { Lens, LensNarrowing, ModelDefaultNarrowing, ModelNarrowing } from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

export type VisitEffect = {
  /** Set of visible field names after composition. null = no picks declared → all visible. */
  visibleFields: Set<string> | null;
  hiddenFields: Set<string>;
  /** Per-field allowed enum values (after composition with registry + defaults + per-field picks/omits). */
  enumValuesByField: Map<string, readonly string[]>;
  /** Where clauses anchored at THIS visit (mapDefaults model + path-specific root/relations). */
  whereClauses: Condition[];
  /** Per-relation narrowings declared at this visit's level (for descent). Path-specific only. */
  relations: Map<string, ModelNarrowing>;
};

export type Policy = {
  lens: Lens;
  chain: LensNarrowing[];
};

export const resolvePolicy = (lensOrNarrowing: Lens | LensNarrowing): Policy => {
  const lens = getRoot(lensOrNarrowing);
  const chain =
    (lensOrNarrowing as Lens).maps === lens.maps
      ? []
      : collectChain(lensOrNarrowing as LensNarrowing);
  return { lens, chain };
};

/**
 * Intersection-or-init: if `cur` is null (no prior set), returns Set(next).
 * Otherwise returns Set(next ∩ cur). Used by all the picks/enumPicks accumulators
 * since "first declaration creates the set, later declarations intersect."
 */
export const intersectStringSet = (
  cur: Set<string> | null,
  next: readonly string[],
): Set<string> => {
  if (cur === null) return new Set(next);
  return new Set(next.filter((x) => cur.has(x)));
};

/** Returns picks list augmented with any relation keys (so descent fields stay reachable). */
export const augmentPicksWithRelations = (
  n: ModelDefaultNarrowing | ModelNarrowing,
): readonly string[] | undefined => {
  if (!n.picks) return undefined;
  if (!('relations' in n) || !n.relations) return n.picks;
  const out = [...n.picks];
  for (const rel of Object.keys(n.relations)) {
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
};

const accumulateInto = (out: VisitEffect, n: ModelDefaultNarrowing | ModelNarrowing): void => {
  const augmented = augmentPicksWithRelations(n);
  if (augmented) out.visibleFields = intersectStringSet(out.visibleFields, augmented);
  if (n.omits) for (const f of n.omits) out.hiddenFields.add(f);
  if (n.where !== undefined) out.whereClauses.push(n.where);
};

/**
 * Resolve the effective narrowing facts for a single model visit.
 *
 * @param policy resolved policy from a lens/narrowing chain
 * @param mapName current map being visited
 * @param modelName current model
 * @param relPath sequence of relation names from the lens's root model to this visit
 *               (empty array = root visit)
 */
export const resolveVisit = (
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): VisitEffect => {
  const out: VisitEffect = {
    visibleFields: null,
    hiddenFields: new Set(),
    enumValuesByField: new Map(),
    whereClauses: [],
    relations: new Map(),
  };

  const fieldMap: FieldMap | undefined = policy.lens.maps[mapName];
  const model = fieldMap?.models[modelName];
  if (!model) return out;

  // Track per-field enum picks/omits accumulators (intersection / union)
  const fieldEnumPicks = new Map<string, Set<string>>();
  const fieldEnumOmits = new Map<string, Set<string>>();
  // Track enum-type-level narrowing from mapDefaults.enums across chain
  const typeEnumPicks = new Map<string, Set<string>>();
  const typeEnumOmits = new Map<string, Set<string>>();

  const accEnumFields = (n: ModelDefaultNarrowing | ModelNarrowing): void => {
    if (n.enumPicks) {
      for (const [f, vals] of Object.entries(n.enumPicks)) {
        const cur = fieldEnumPicks.get(f) ?? null;
        fieldEnumPicks.set(
          f,
          cur === null ? new Set(vals) : new Set(vals.filter((v) => cur.has(v))),
        );
      }
    }
    if (n.enumOmits) {
      for (const [f, vals] of Object.entries(n.enumOmits)) {
        const s = fieldEnumOmits.get(f) ?? new Set<string>();
        for (const v of vals) s.add(v);
        fieldEnumOmits.set(f, s);
      }
    }
  };

  for (const narrowing of policy.chain) {
    // 1. mapDefaults[mapName].models[modelName] — applies wherever this model
    //    appears in this map (NOT the lens's root map).
    const visitMapDefaults = narrowing.mapDefaults?.[mapName];
    if (visitMapDefaults) {
      const dflt = visitMapDefaults.models?.[modelName];
      if (dflt) {
        accumulateInto(out, dflt);
        accEnumFields(dflt);
      }

      // 2. mapDefaults[mapName].enums — accumulate per type from this map's enums
      for (const [enumName, enumN] of Object.entries(visitMapDefaults.enums ?? {})) {
        if (enumN.picks) {
          const cur = typeEnumPicks.get(enumName) ?? null;
          typeEnumPicks.set(
            enumName,
            cur === null ? new Set(enumN.picks) : new Set(enumN.picks.filter((v) => cur.has(v))),
          );
        }
        if (enumN.omits) {
          const s = typeEnumOmits.get(enumName) ?? new Set<string>();
          for (const v of enumN.omits) s.add(v);
          typeEnumOmits.set(enumName, s);
        }
      }
    }

    // 3. Path-specific (root): anchored at (lens.mapName, lens.model), descended
    //    via relPath. Cross-map bridges descend into a different map but the
    //    narrowing still lives in narrowing.root's relations tree.
    let node: ModelNarrowing | undefined = narrowing.root;
    if (relPath.length === 0) {
      // Root visit: node IS narrowing.root. Only apply if we're actually visiting the root.
      if (mapName === policy.lens.mapName && modelName === policy.lens.model && node) {
        accumulateInto(out, node);
        accEnumFields(node);
        for (const [rel, sub] of Object.entries(node.relations ?? {})) {
          out.relations.set(rel, sub);
        }
      }
    } else {
      // Descend along relPath from narrowing.root
      for (const seg of relPath) {
        node = node?.relations?.[seg];
        if (!node) break;
      }
      if (node) {
        accumulateInto(out, node);
        accEnumFields(node);
        for (const [rel, sub] of Object.entries(node.relations ?? {})) {
          out.relations.set(rel, sub);
        }
      }
    }
  }

  // 4. Resolve per-field enum values: per-field picks/omits ∩ type-level ∩ (entry.values ?? registry)
  for (const [fieldName, entry] of Object.entries(model.fields)) {
    if (entry.kind !== 'enum') continue;
    const enumType = entry.type;
    const registryVals = fieldMap?.enums?.[enumType];
    const baseValues = entry.values ?? registryVals;
    if (!baseValues) continue;
    let vals: readonly string[] = baseValues;
    // Apply type-level narrowing
    const typePicks = typeEnumPicks.get(enumType);
    const typeOmits = typeEnumOmits.get(enumType);
    if (typePicks) vals = vals.filter((v) => typePicks.has(v));
    if (typeOmits) vals = vals.filter((v) => !typeOmits.has(v));
    // Apply field-level narrowing
    const fp = fieldEnumPicks.get(fieldName);
    const fo = fieldEnumOmits.get(fieldName);
    if (fp) vals = vals.filter((v) => fp.has(v));
    if (fo) vals = vals.filter((v) => !fo.has(v));
    out.enumValuesByField.set(fieldName, vals);
  }

  return out;
};

/** Returns true if fieldName is visible at this visit (after all picks/omits). */
export const isFieldVisible = (effect: VisitEffect, fieldName: string): boolean => {
  if (effect.hiddenFields.has(fieldName)) return false;
  if (effect.visibleFields !== null && !effect.visibleFields.has(fieldName)) return false;
  return true;
};

/** Returns the allowed enum values for a field, or null if the field isn't an enum / no registry. */
export const allowedEnumValues = (
  effect: VisitEffect,
  fieldName: string,
): readonly string[] | null => effect.enumValuesByField.get(fieldName) ?? null;

/**
 * Walks a dot-path from a model visit, resolving each segment against the lens schema,
 * and returns the final model context (mapName, modelName, segments path) and the
 * terminal field entry. Returns null if any segment doesn't resolve.
 */
export const walkLensPath = (
  policy: Policy,
  startMap: string,
  startModel: string,
  startPath: readonly string[],
  fieldPath: string,
): {
  mapName: string;
  modelName: string;
  relPath: string[];
  entry: import('../toPrisma/types.ts').FieldMapEntry;
  /** For each intermediate hop, the effect at that visit (excluding the terminal). */
  hopEffects: VisitEffect[];
  /** Effect at the terminal model. */
  terminalEffect: VisitEffect;
  /** The terminal field's name within the terminal model. */
  terminalFieldName: string;
} | null => {
  const parts = fieldPath.split('.');
  let mapName = startMap;
  let modelName = startModel;
  let relPath = [...startPath];
  const hopEffects: VisitEffect[] = [];

  for (let i = 0; i < parts.length; i++) {
    const fieldMap = policy.lens.maps[mapName];
    const model = fieldMap?.models[modelName];
    if (!model) return null;
    const effect = resolveVisit(policy, mapName, modelName, relPath);
    const fieldName = parts[i];
    if (!isFieldVisible(effect, fieldName)) return null;
    const entry = model.fields[fieldName];
    if (!entry) return null;
    if (i === parts.length - 1) {
      return {
        mapName,
        modelName,
        relPath,
        entry,
        hopEffects,
        terminalEffect: effect,
        terminalFieldName: fieldName,
      };
    }
    hopEffects.push(effect);
    const target = resolveRelationTarget(entry, mapName);
    if (!target) return null;
    relPath = [...relPath, fieldName];
    mapName = target.mapName;
    modelName = target.modelName;
  }
  return null;
};
