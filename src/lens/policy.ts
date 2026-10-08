import { declaredEnumValues, isJsonEntry } from '../fieldMap/entry';
import type { FieldMap, FieldMapEntry } from '../fieldMap/types';
import { type MapVisit, relationTargetOf, walkMaps } from '../fieldMap/walk.ts';
import { modelOf, own } from '../own';
import { readScopeRef } from '../scope';
import type { Condition } from '../types.ts';
import { collectChain, getLensRoot } from './chain.ts';
import { narrowAt } from './narrowRule.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  SourceEntry,
  SourceSpec,
} from './types.ts';

export type VisitEffect = {
  picks: Set<string> | null;
  omits: Set<string>;
  enumValuesByField: Map<string, readonly string[]>;
  whereClauses: Condition[];
  sources: Map<string, Condition[]>;
  /** Per-field display label (from a SourceSpec's `label`): a sibling column or a dotted
   * to-one path; a later layer wins. */
  sourceLabels: Map<string, string>;
  /** Per-field option-partition axes (from a SourceSpec's `groupBy`, normalized); a later layer wins. */
  sourceGroupBys: Map<string, string[]>;
  /** The chain index of the earliest layer that declared each source's label / axes (keyed by
   *  `declaredKey`): every layer after it that hides one of those columns drops it. */
  sourceDeclaredAt: Map<string, number>;
  /** Fields whose path source points at the model's own source (`from: 'mapDefaults'`), with
   *  the chain index of the earliest layer that points: the layers above it still carry. */
  sourcesFromMapDefaults: Map<string, number>;
  relations: Map<string, ModelNarrowing>;
};

/** Normalize a `groupBy` declaration to its axes array (a bare string is one axis). */
export const normalizeGroupBy = (g: string | string[] | undefined): string[] | undefined =>
  g === undefined ? undefined : Array.isArray(g) ? g : [g];

/** A `sources` entry is a `SourceSpec` when it carries `where`/`label`/`groupBy`; else it's a bare `Condition`. */
export const isSourceSpec = (v: SourceEntry): v is SourceSpec =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  ('where' in v || 'label' in v || 'groupBy' in v || 'from' in v);

/** Normalize a `sources` entry to a `SourceSpec` — a bare `Condition` becomes its `where`. */
export const normalizeSource = (v: SourceEntry): SourceSpec => {
  if (isSourceSpec(v)) return v;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
    throw new Error('sources: {} is not a Condition — use `true` for an unconstrained source');
  return { where: v };
};

export type Policy = {
  lens: Lens;
  chain: LensNarrowing[];
};

/** A relPath matching no declared `root.relations` path — `resolveVisit` then applies
 * mapDefaults only: the model-intrinsic visit a model gets wherever it is reached off-path. */
export const OFF_PATH: readonly string[] = ['__offpath__'];

export const resolvePolicy = (lensOrNarrowing: Lens | LensNarrowing): Policy => {
  const lens = getLensRoot(lensOrNarrowing);
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

const accumulatePicksOmitsInto = (
  state: { picks: Set<string> | null; omits: Set<string> },
  n: ModelDefaultNarrowing | ModelNarrowing,
): void => {
  const augmented = augmentPicksWithRelations(n);
  if (augmented) state.picks = intersectStringSet(state.picks, augmented);
  if (n.omits) for (const f of n.omits) state.omits.add(f);
};

const intersectIntoMap = (
  map: Map<string, Set<string>>,
  key: string,
  vals: readonly string[],
): void => {
  map.set(key, intersectStringSet(map.get(key) ?? null, vals));
};

const unionIntoMap = (
  map: Map<string, Set<string>>,
  key: string,
  vals: readonly string[],
): void => {
  const s = map.get(key) ?? new Set<string>();
  for (const v of vals) s.add(v);
  map.set(key, s);
};

const accumulateEnumFields = (
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

const declaredKey = (field: string, kind: 'label' | 'groupBy', value: string | string[]): string =>
  JSON.stringify([field, kind, value]);

const accumulateInto = (
  out: VisitEffect,
  n: ModelDefaultNarrowing | ModelNarrowing,
  narrow: (condition: Condition) => Condition,
  layer: number,
): void => {
  accumulatePicksOmitsInto(out, n);
  if (n.where !== undefined) out.whereClauses.push(narrow(n.where));
  if (n.sources) {
    for (const [field, entry] of Object.entries(n.sources)) {
      const spec = normalizeSource(entry);
      const clauses = out.sources.get(field) ?? [];
      if (spec.where !== undefined) clauses.push(narrow(spec.where));
      out.sources.set(field, clauses); // register the field even when only a label is set
      const axes = normalizeGroupBy(spec.groupBy);
      for (const [kind, value] of [
        ['label', spec.label],
        ['groupBy', axes],
      ] as const) {
        if (value === undefined) continue;
        const key = declaredKey(field, kind, value);
        if (!out.sourceDeclaredAt.has(key)) out.sourceDeclaredAt.set(key, layer);
      }
      if (spec.label !== undefined) out.sourceLabels.set(field, spec.label);
      if (axes !== undefined) out.sourceGroupBys.set(field, axes);
      if (spec.from === 'mapDefaults' && !out.sourcesFromMapDefaults.has(field))
        out.sourcesFromMapDefaults.set(field, layer);
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
    sourceGroupBys: new Map(),
    sourceDeclaredAt: new Map(),
    sourcesFromMapDefaults: new Map(),
    relations: new Map(),
  };

  const fieldMap: FieldMap | undefined = own(policy.lens.maps, mapName);
  const model = modelOf(fieldMap, modelName);
  if (!model) return out;

  const fieldEnumPicks = new Map<string, Set<string>>();
  const fieldEnumOmits = new Map<string, Set<string>>();
  const typeEnumPicks = new Map<string, Set<string>>();
  const typeEnumOmits = new Map<string, Set<string>>();

  // A layer's own conditions read through its parent: the relations they reach carry the
  // grants of every layer above, as a user rule's do — a child can't see what its parent hides.
  let narrow = (condition: Condition): Condition => condition;
  let current = 0;
  const applyNode = (n: ModelDefaultNarrowing | ModelNarrowing): void => {
    accumulateInto(out, n, narrow, current);
    accumulateEnumFields(fieldEnumPicks, fieldEnumOmits, n);
  };

  for (const [layer, narrowing] of policy.chain.entries()) {
    current = layer;
    const parent: Policy = { lens: policy.lens, chain: policy.chain.slice(0, layer) };
    narrow = (condition) =>
      layer === 0 ? condition : narrowAt(condition, parent, { mapName, modelName, relPath });
    const visitMapDefaults = own(narrowing.mapDefaults, mapName);
    if (visitMapDefaults) {
      const dflt = own(visitMapDefaults.models, modelName);
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
        node = own(node?.relations, seg);
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
      optionValues ?? (isEnum ? declaredEnumValues(entry, fieldMap?.enums) : entry.values);
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

/** Whether some layer's mapDefaults declares the model's own source for `field` — what a
 *  `from: 'mapDefaults'` path source offers. */
export const declaresModelSource = (
  policy: Policy,
  mapName: string,
  modelName: string,
  field: string,
): boolean => resolveVisit(policy, mapName, modelName, OFF_PATH).sources.has(field);

/** A `from: 'mapDefaults'` path source whose model declares no source of its own. */
export const undeclaredModelSource = (
  path: string,
  mapName: string,
  modelName: string,
  field: string,
): Error =>
  new Error(
    `source '${field}' at '${path}' offers mapDefaults.${mapName}.models.${modelName}.sources.${field}, which no layer declares`,
  );

export const isFieldVisible = (effect: VisitEffect, fieldName: string): boolean => {
  if (effect.omits.has(fieldName)) return false;
  if (effect.picks !== null && !effect.picks.has(fieldName)) return false;
  return true;
};

export const allowedEnumValues = (
  effect: VisitEffect,
  fieldName: string,
): readonly string[] | null => effect.enumValuesByField.get(fieldName) ?? null;

export type LensPathHop = {
  field: string;
  entry: FieldMapEntry;
  mapName: string;
  model: string;
  /** The relation path from the lens anchor to the model this hop reads. */
  relPath: string[];
};

/**
 * Where a dotted path lands through the lens, hop by hop. `hidden` is a field the model has but
 * the narrowing does not expose at this visit; `missing` is a field the model does not have (or a
 * model the map does not have); `pastScalar` is a segment after a scalar. A path that continues
 * below a Json column resolves at the column with the remainder in `jsonSubPath`.
 */
export type LensPathResolution =
  | { outcome: 'resolved'; hops: LensPathHop[]; terminal: LensPathHop; jsonSubPath: string[] }
  | { outcome: 'hidden' | 'missing' | 'pastScalar'; index: number; hops: LensPathHop[] };

export const resolvePolicyPath = (
  policy: Policy,
  from: MapVisit,
  path: string,
): { resolution: LensPathResolution; effects: VisitEffect[] } => {
  const parts = path.split('.');
  const hops: LensPathHop[] = [];
  const effects: VisitEffect[] = [];
  for (const { index: i, field: fieldName, at, entry, next } of walkMaps(
    policy.lens.maps,
    from,
    path,
  )) {
    if (!entry) return { resolution: { outcome: 'missing', index: i, hops }, effects };
    const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
    if (!isFieldVisible(effect, fieldName))
      return { resolution: { outcome: 'hidden', index: i, hops }, effects };
    const hop: LensPathHop = {
      field: fieldName,
      entry,
      mapName: at.mapName,
      model: at.modelName,
      relPath: [...at.relPath],
    };
    hops.push(hop);
    effects.push(effect);
    const last = i === parts.length - 1;
    // A Json column declares no sub-fields; the evaluators resolve the remainder against the
    // value, so the path resolves at the column and carries the remainder.
    if (last || isJsonEntry(entry)) {
      return {
        resolution: {
          outcome: 'resolved',
          hops,
          terminal: hop,
          jsonSubPath: last ? [] : parts.slice(i + 1),
        },
        effects,
      };
    }
    if (!next) return { resolution: { outcome: 'pastScalar', index: i, hops }, effects };
  }
  return { resolution: { outcome: 'missing', index: parts.length, hops }, effects };
};

/**
 * Whether a source's label or axes, as in force at a visit, read only columns every layer but
 * their earliest declaration shows. The declaring layer may source a column it hides itself; any
 * other layer that hides it — an ancestor, or a layer after — drops it, so re-declaring an
 * ancestor's label never revives what a layer in between hid. A path that doesn't resolve stays,
 * for the compile to refuse.
 */
export const sourceReadsVisible = (
  policy: Policy,
  effect: VisitEffect,
  at: MapVisit,
  field: string,
  kind: 'label' | 'groupBy',
): boolean => {
  const value =
    kind === 'label' ? effect.sourceLabels.get(field) : effect.sourceGroupBys.get(field);
  if (value === undefined) return true;
  const from = effect.sourceDeclaredAt.get(declaredKey(field, kind, value)) ?? -1;
  const others = { lens: policy.lens, chain: policy.chain.filter((_, i) => i !== from) };
  return (typeof value === 'string' ? [value] : value).every(
    (path) => resolvePolicyPath(others, at, path).resolution.outcome !== 'hidden',
  );
};

export const lensPathEnd = (
  policy: Policy,
  from: MapVisit,
  fieldPath: string,
): {
  mapName: string;
  modelName: string;
  relPath: string[];
  entry: FieldMapEntry;
  terminalEffect: VisitEffect;
  terminalFieldName: string;
  /** Segments consumed below a Json boundary — empty when the path ends on the declared entry. */
  jsonSubPath: string[];
} | null => {
  const { resolution, effects } = resolvePolicyPath(policy, from, fieldPath);
  if (resolution.outcome !== 'resolved') return null;
  const { terminal, jsonSubPath } = resolution;
  return {
    mapName: terminal.mapName,
    modelName: terminal.model,
    relPath: terminal.relPath,
    entry: terminal.entry,
    terminalEffect: effects[effects.length - 1],
    terminalFieldName: terminal.field,
    jsonSubPath,
  };
};

/** Where a rule visit stands: a model reached through the lens, or open inside a Json value. */
export type VisitScope = MapVisit & { open: boolean };

export const lensRootScope = (policy: Policy): VisitScope => ({
  mapName: policy.lens.mapName,
  modelName: policy.lens.model,
  relPath: [],
  open: false,
});

export type LensWalk = NonNullable<ReturnType<typeof lensPathEnd>>;

/**
 * The scope a node's `field` leads into — where its `condition` / `filter` resolve — with the
 * scope the walk started from and the walk that reached it (none inside an open Json scope), or the issue that stops it. A `$`-prefixed
 * field counts scopes up the stack as check() does.
 */
export const stepIntoField = (
  policy: Policy,
  scopes: readonly VisitScope[],
  field: string,
):
  | { from: VisitScope; next: VisitScope; walked: LensWalk | null }
  | { issue: { code: 'scope_out_of_bounds' | 'not_in_lens'; message: string } } => {
  const target = readScopeRef(field, scopes);
  if ('outOfBounds' in target)
    return { issue: { code: 'scope_out_of_bounds', message: target.outOfBounds } };
  if (target.scope.open) return { from: target.scope, next: target.scope, walked: null };
  const walked = lensPathEnd(policy, target.scope, target.path);
  if (!walked)
    return {
      issue: { code: 'not_in_lens', message: 'path does not resolve through the narrowed lens' },
    };
  const open = isJsonEntry(walked.entry);
  const relation = relationTargetOf(walked.entry, walked.mapName);
  const next = relation
    ? { ...relation, relPath: [...walked.relPath, walked.terminalFieldName], open }
    : { ...target.scope, open };
  return { from: target.scope, next, walked };
};

/** A relation a path crosses: the visit it reaches, its dotted prefix, and whether it's to-many. */
export type RelationHop = {
  map: string;
  model: string;
  relPath: string[];
  prefix: string;
  isList: boolean;
};

/**
 * The relations a path crosses from a visit, read from the field maps — grants apply to a relation
 * whether or not it is visible, so this walk does not gate. It stops at the first segment that
 * isn't a relation; `end` is the visit the last segment reaches when every segment is one.
 * `prefix` is prepended to each hop's dotted prefix (a `$`-scope ref).
 */
export const relationHops = (
  maps: Record<string, FieldMap>,
  from: MapVisit,
  path: string,
  prefix = '',
): {
  hops: RelationHop[];
  end: MapVisit | null;
} => {
  const parts = path.split('.');
  const hops: RelationHop[] = [];
  let end: MapVisit | null = null;
  for (const { index: i, field, at, entry, next } of walkMaps(maps, from, path)) {
    if (!entry || !next) break;
    const relPath = [...at.relPath, field];
    hops.push({
      map: next.mapName,
      model: next.modelName,
      relPath,
      prefix: `${prefix}${parts.slice(0, i + 1).join('.')}`,
      isList: entry.isList === true,
    });
    if (i === parts.length - 1) end = { ...next, relPath: [...relPath] };
  }
  return { hops, end };
};
