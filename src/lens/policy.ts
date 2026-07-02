import type { FieldMap } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  SourceSpec,
  SourceValue,
} from './types.ts';
import { collectChain, getRoot, resolveRelationTarget } from './walk.ts';

export type VisitEffect = {
  picks: Set<string> | null;
  omits: Set<string>;
  enumValuesByField: Map<string, readonly string[]>;
  whereClauses: Condition[];
  sources: Map<string, Condition[]>;
  /** Per-field display-label column (from a SourceSpec's `label`); a later layer wins. */
  sourceLabels: Map<string, string>;
  relations: Map<string, ModelNarrowing>;
};

/** A `sources` entry is a `SourceSpec` when it carries `where`/`label`; else it's a bare `Condition`. */
export const isSourceSpec = (v: SourceValue): v is SourceSpec =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && ('where' in v || 'label' in v);

/** Normalize a `sources` entry to a `SourceSpec` — a bare `Condition` becomes its `where`. */
export const normalizeSource = (v: SourceValue): SourceSpec => (isSourceSpec(v) ? v : { where: v });

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

export const intersectStringSet = (
  cur: Set<string> | null,
  next: readonly string[],
): Set<string> => {
  if (cur === null) return new Set(next);
  return new Set(next.filter((x) => cur.has(x)));
};

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

export const accumulatePicksOmitsInto = (
  state: { picks: Set<string> | null; omits: Set<string> },
  n: ModelDefaultNarrowing | ModelNarrowing,
): void => {
  const augmented = augmentPicksWithRelations(n);
  if (augmented) state.picks = intersectStringSet(state.picks, augmented);
  if (n.omits) for (const f of n.omits) state.omits.add(f);
};

export const intersectIntoMap = (
  map: Map<string, Set<string>>,
  key: string,
  vals: readonly string[],
): void => {
  map.set(key, intersectStringSet(map.get(key) ?? null, vals));
};

export const unionIntoMap = (
  map: Map<string, Set<string>>,
  key: string,
  vals: readonly string[],
): void => {
  const s = map.get(key) ?? new Set<string>();
  for (const v of vals) s.add(v);
  map.set(key, s);
};

export const accumulateEnumFields = (
  picksMap: Map<string, Set<string>>,
  omitsMap: Map<string, Set<string>>,
  n: ModelDefaultNarrowing | ModelNarrowing,
): void => {
  if (n.enumPicks) {
    for (const [f, vals] of Object.entries(n.enumPicks)) intersectIntoMap(picksMap, f, vals);
  }
  if (n.enumOmits) {
    for (const [f, vals] of Object.entries(n.enumOmits)) unionIntoMap(omitsMap, f, vals);
  }
};

const accumulateInto = (out: VisitEffect, n: ModelDefaultNarrowing | ModelNarrowing): void => {
  accumulatePicksOmitsInto(out, n);
  if (n.where !== undefined) out.whereClauses.push(n.where);
  if (n.sources) {
    for (const [field, entry] of Object.entries(n.sources)) {
      const spec = normalizeSource(entry);
      const clauses = out.sources.get(field) ?? [];
      if (spec.where !== undefined) clauses.push(spec.where);
      out.sources.set(field, clauses); // register the field even when only a label is set
      if (spec.label !== undefined) out.sourceLabels.set(field, spec.label);
    }
  }
};

export const resolveVisit = (
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): VisitEffect => {
  const out: VisitEffect = {
    picks: null,
    omits: new Set(),
    enumValuesByField: new Map(),
    whereClauses: [],
    sources: new Map(),
    sourceLabels: new Map(),
    relations: new Map(),
  };

  const fieldMap: FieldMap | undefined = policy.lens.maps[mapName];
  const model = fieldMap?.models[modelName];
  if (!model) return out;

  const fieldEnumPicks = new Map<string, Set<string>>();
  const fieldEnumOmits = new Map<string, Set<string>>();
  const typeEnumPicks = new Map<string, Set<string>>();
  const typeEnumOmits = new Map<string, Set<string>>();

  const applyNode = (n: ModelDefaultNarrowing | ModelNarrowing): void => {
    accumulateInto(out, n);
    accumulateEnumFields(fieldEnumPicks, fieldEnumOmits, n);
  };

  for (const narrowing of policy.chain) {
    const visitMapDefaults = narrowing.mapDefaults?.[mapName];
    if (visitMapDefaults) {
      const dflt = visitMapDefaults.models?.[modelName];
      if (dflt) applyNode(dflt);
      for (const [enumName, enumN] of Object.entries(visitMapDefaults.enums ?? {})) {
        if (enumN.picks) intersectIntoMap(typeEnumPicks, enumName, enumN.picks);
        if (enumN.omits) unionIntoMap(typeEnumOmits, enumName, enumN.omits);
      }
    }

    let node: ModelNarrowing | undefined = narrowing.root;
    if (relPath.length === 0) {
      if (mapName === policy.lens.mapName && modelName === policy.lens.model && node) {
        applyNode(node);
        for (const [rel, sub] of Object.entries(node.relations ?? {})) out.relations.set(rel, sub);
      }
    } else {
      for (const seg of relPath) {
        node = node?.relations?.[seg];
        if (!node) break;
      }
      if (node) {
        applyNode(node);
        for (const [rel, sub] of Object.entries(node.relations ?? {})) out.relations.set(rel, sub);
      }
    }
  }

  for (const [fieldName, entry] of Object.entries(model.fields)) {
    const isEnum = entry.kind === 'enum';
    // Enums draw from the registry; any other kind (scalar, Json) is gated by an explicit
    // `values` set. A hydrated source's folded `options` gate too and win when present — a
    // consumer re-feeds an exposed surface here, so this is load-bearing (see
    // test/lens.sourceOptionsGating.test.ts).
    const optionValues = entry.options?.map((o) => o.value);
    const baseValues =
      optionValues ?? (isEnum ? (entry.values ?? fieldMap?.enums?.[entry.type]) : entry.values);
    if (!baseValues) continue;
    let vals: readonly string[] = baseValues;
    if (isEnum) {
      const typePicks = typeEnumPicks.get(entry.type);
      const typeOmits = typeEnumOmits.get(entry.type);
      if (typePicks) vals = vals.filter((v) => typePicks.has(v));
      if (typeOmits) vals = vals.filter((v) => !typeOmits.has(v));
    }
    const fp = fieldEnumPicks.get(fieldName);
    const fo = fieldEnumOmits.get(fieldName);
    if (fp) vals = vals.filter((v) => fp.has(v));
    if (fo) vals = vals.filter((v) => !fo.has(v));
    out.enumValuesByField.set(fieldName, vals);
  }

  return out;
};

export const isFieldVisible = (effect: VisitEffect, fieldName: string): boolean => {
  if (effect.omits.has(fieldName)) return false;
  if (effect.picks !== null && !effect.picks.has(fieldName)) return false;
  return true;
};

export const allowedEnumValues = (
  effect: VisitEffect,
  fieldName: string,
): readonly string[] | null => effect.enumValuesByField.get(fieldName) ?? null;

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
  hopEffects: VisitEffect[];
  terminalEffect: VisitEffect;
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
    // A Json column has no declared sub-fields; a dotted sub-path into it is resolved
    // by the evaluators/compilers (check/toPrisma/toSql), so the field resolves to the
    // visible Json column — stop here and treat it as the terminal.
    if (entry.kind === 'scalar' && entry.type === 'Json' && i < parts.length - 1) {
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
