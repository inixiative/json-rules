import { declaredEnumValues, isJsonEntry, isRelationEntry } from '../fieldMap/entry';
import type { FieldMap, FieldMapEntry, ModelEntry } from '../fieldMap/types';
import { type MapVisit, relationTargetOf, walkMaps } from '../fieldMap/walk.ts';
import { fieldOf, modelOf, own } from '../own';
import { parseScopeRef, readScopeRef } from '../scope';
import { isLogicalNode, isRelationNode, valueRefs, visitCondition } from '../traverse';
import type { Condition } from '../types.ts';
import type { ValidationIssue } from '../validate';
import { collectChain, getLensRoot, isLens } from './chain.ts';
import { narrowAt } from './narrowRule.ts';
import type {
  Lens,
  LensNarrowing,
  ModelDefaultNarrowing,
  ModelNarrowing,
  SourceEntry,
  SourceSpec,
} from './types.ts';
import { checkConditionAtVisit } from './validateRuleInLens.ts';

export type VisitEffect = {
  picks: Set<string> | null;
  omits: Set<string>;
  enumValuesByField: Map<string, readonly string[]>;
  whereClauses: Condition[];
  sources: Map<string, Condition[]>;
  /** Per-field source eligibility wheres as each layer wrote them, unnarrowed: what a source plan
   *  narrows under the whole lens, as a rule is. */
  sourceWheres: Map<string, Condition[]>;
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
  /** The relations turned on at this visit and not omitted: the only ones a rule, a source
   *  label or axis, a read or a fetch may cross from here. */
  relations: Set<string>;
  /** Every relation field of the visit's model: what `picks` never governs. */
  relationFields: Set<string>;
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

/** Normalize a `sources` entry to a `SourceSpec` — a bare `Condition` becomes its `where`; `{}` is
 *  neither, and refused. */
export const normalizeSource = (v: SourceEntry): SourceSpec => {
  if (isSourceSpec(v)) return v;
  if (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0)
    throw emptySource();
  return { where: v };
};

export const emptySource = (): LensRefusal =>
  new LensRefusal(
    'sources: {} is not a Condition — use `true` for an unconstrained source',
    'invalid_source',
  );

export type Policy = {
  lens: Lens;
  chain: LensNarrowing[];
  /** The first narrowing over the base lens — the one layer that turns relations on. A policy
   *  whose chain a caller filters keeps it, so a dropped layer never makes another one first. */
  origin?: LensNarrowing;
  /** A read off the menu: any relation not omitted, turned on or not. The first narrowing's
   *  clamps read the schema this way; column visibility still applies. */
  clamp?: boolean;
  /** What this call has worked out, shared by the policies it derives. */
  memo?: CallMemo;
  /** A layer whose own clamps are dropped (a source pointer's), keeping the chain's indices — so
   *  later layers' clamps still read through it. */
  skipClampsOf?: LensNarrowing;
  /** Skip the runtime vetting of later layers' clamps: validateNarrowing enumerating the visits
   *  they apply at before it checks them. */
  unvetted?: boolean;
  /** A layer whose own picks and omits are not applied, keeping the chain's indices: a source's
   *  label or axes read what every layer but the one declaring them shows. */
  skipHidingOf?: LensNarrowing;
  /** validateNarrowing running the postures: each runs as at runtime and refuses what it refuses,
   *  but compiles nothing, so no value — a binding, the clock, a literal — is read. */
  inspect?: boolean;
};

/** One call's work, kept for that call alone — never past it, so a narrowing edited in place reads
 *  fresh next time (the default trees excepted, kept on the first narrowing by fingerprint). */
type CallMemo = {
  /** The model-default trees, by spelled node. */
  trees: Map<string, DefaultTree>;
  /** The later clamps already checked at a visit, keyed by clamp, visit and the layers it reads
   *  through. */
  vetted: Set<string>;
  /** The visits resolved, keyed by visit and the policy's layers. */
  effects: Map<string, ResolvedVisit>;
  /** Where each visit stands: its trail and the relations the first narrowing turns on there,
   *  keyed by visit and that narrowing. */
  places: Map<string, Place>;
  /** Each model's fields as read. */
  models: Map<ModelEntry, ModelFields>;
  /** Each clamp's first bare value ref and first ref climbing out of it. */
  refs: Map<Condition, { bare: string | null; escaping: string | null }>;
  /** Why toPrisma can't compile a condition at a model (null: it can), by map and model. */
  compiles: Map<Condition, Map<string, string | null>>;
};

type Place = { trail: MapVisit[] | null; turnedOn: string[] };
type ModelFields = { relations: Set<string>; gated: [string, FieldMapEntry][] };

/** A resolved visit, and — resolved unvetted — the checks of its later clamps not yet made. */
type ResolvedVisit = { effect: VisitEffect; unchecked: (() => void)[] | null };

/** A relPath reached from no anchor — `resolveVisit` then applies the model's own defaults only:
 * the model-intrinsic visit a model default's clamp and source are checked at. */
export const OFF_PATH: readonly string[] = ['__offpath__'];

// Trees are kept on the first narrowing under a fingerprint of the base lens it stands on and its
// model defaults (and, per tree, of its spelled node's own turn-ons and omits): a narrowing edited
// or re-parented in place grows fresh trees. A field map edited in place is not seen.
const TREES = new WeakMap<
  LensNarrowing,
  { fingerprint: string; trees: Map<string, DefaultTree> }
>();
const treesFor = (lens: Lens, origin: LensNarrowing | undefined): Map<string, DefaultTree> => {
  if (!origin) return new Map();
  const fingerprint = JSON.stringify([
    idOf(origin.parent),
    idOf(lens.maps),
    lens.mapName,
    lens.model,
    origin.mapDefaults ?? null,
  ]);
  const kept = TREES.get(origin);
  if (kept?.fingerprint === fingerprint) return kept.trees;
  const trees = new Map<string, DefaultTree>();
  TREES.set(origin, { fingerprint, trees });
  return trees;
};

// A stable id per object, for memo keys.
const IDS = new WeakMap<object, number>();
let nextId = 0;
const idOf = (value: object): number => {
  let id = IDS.get(value);
  if (id === undefined) {
    id = nextId++;
    IDS.set(value, id);
  }
  return id;
};

// Joins the parts of a memo key: no name holds it.
const SEP = '\u0000';

// What resolveVisit reads off a model on every visit: its relation fields, and the fields a set of
// values gates (options, an enum, or `values`).
const modelFields = (model: ModelEntry): ModelFields => {
  const entries = Object.entries(model.fields);
  return {
    relations: new Set(entries.filter(([, entry]) => isRelationEntry(entry)).map(([f]) => f)),
    gated: entries.filter(
      ([, entry]) =>
        entry.options !== undefined || entry.kind === 'enum' || entry.values !== undefined,
    ),
  };
};
const idOrNone = (value: object | undefined): string => (value ? String(idOf(value)) : '');

export const resolvePolicy = (lensOrNarrowing: Lens | LensNarrowing): Policy => {
  const lens = getLensRoot(lensOrNarrowing);
  const chain = isLens(lensOrNarrowing) ? [] : collectChain(lensOrNarrowing);
  return {
    lens,
    chain,
    origin: chain[0],
    memo: {
      trees: treesFor(lens, chain[0]),
      vetted: new Set(),
      effects: new Map(),
      places: new Map(),
      models: new Map(),
      refs: new Map(),
      compiles: new Map(),
    },
  };
};

export const intersectStringSet = (
  cur: Set<string> | null,
  next: readonly string[],
): Set<string> => {
  if (cur === null) return new Set(next);
  return new Set(next.filter((x) => cur.has(x)));
};

const accumulatePicksOmitsInto = (
  state: { picks: Set<string> | null; omits: Set<string> },
  n: ModelDefaultNarrowing | ModelNarrowing,
): void => {
  if (n.picks) state.picks = intersectStringSet(state.picks, n.picks);
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
  vet: (condition: Condition, source?: boolean) => void,
  clamps: boolean,
  hiding: boolean,
): void => {
  if (hiding) accumulatePicksOmitsInto(out, n);
  if (n.where !== undefined && clamps) {
    vet(n.where);
    out.whereClauses.push(narrow(n.where));
  }
  if (n.sources) {
    for (const [field, entry] of Object.entries(n.sources)) {
      const spec = normalizeSource(entry);
      const clauses = out.sources.get(field) ?? [];
      const wheres = out.sourceWheres.get(field) ?? [];
      if (spec.where !== undefined && clamps) {
        vet(spec.where, true);
        clauses.push(narrow(spec.where));
        wheres.push(spec.where);
      }
      // Register the field even when only a label is set.
      out.sources.set(field, clauses);
      out.sourceWheres.set(field, wheres);
      const axes = normalizeGroupBy(spec.groupBy);
      // The layer that set the value in force is the one its reads are exempt for: restating it
      // keeps that layer, changing it moves to this one.
      for (const [kind, value, inForce] of [
        ['label', spec.label, out.sourceLabels.get(field)],
        ['groupBy', axes, out.sourceGroupBys.get(field)],
      ] as const) {
        if (value === undefined) continue;
        const key = declaredKey(field, kind, value);
        const restated = inForce !== undefined && declaredKey(field, kind, inForce) === key;
        if (!restated) out.sourceDeclaredAt.set(key, layer);
      }
      if (spec.label !== undefined) out.sourceLabels.set(field, spec.label);
      if (axes !== undefined) out.sourceGroupBys.set(field, axes);
      if (spec.from === 'mapDefaults' && !out.sourcesFromMapDefaults.has(field))
        out.sourcesFromMapDefaults.set(field, layer);
    }
  }
};

/** A narrowing the lens refuses to apply: a clamp validateNarrowing reports, met at runtime. */
export class LensRefusal extends Error {
  override name = 'LensRefusal';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** A bare value `path` reads the root row: only a root clamp may compare with one. */
export const misanchoredPath = (ref: string): LensRefusal =>
  new LensRefusal(
    `a bare path ('${ref}') reads the root row, which a clamp at a relation visit or a model default doesn't stand on: use a literal, a bind, or a \`$\` scope ref`,
    'invalid_value_source',
  );

/**
 * What a later layer's clamp reads that its parent doesn't show, at the visit it applies to: the
 * one check validateNarrowing and every runtime posture make — the gate itself, over the parent's
 * surface (every hop and the column at its end).
 */
export const laterClampIssues = (
  condition: Condition,
  parent: Policy,
  at: MapVisit,
): ValidationIssue[] =>
  checkConditionAtVisit(condition, parent, at.mapName, at.modelName, at.relPath);

/** A later layer's clamp reading what its parent doesn't show. */
export const unshownClamp = (issue: ValidationIssue): LensRefusal =>
  new LensRefusal(
    `a later layer's clamp reads what its parent does not show: '${issue.path}' ${issue.message}`,
    issue.code,
  );

/** A scope ref in a clamp that climbs above the clamp's own row. */
export const escapingClampRef = (ref: string): LensRefusal =>
  new LensRefusal(
    `the scope ref '${ref}' climbs out of the clamp: a clamp reads its own row ('$.'), literals and binds`,
    'scope_out_of_bounds',
  );

/** What a clamp reads past its own row: its first bare value ref (a root-row read), and its first
 *  scope ref — a field or a value ref — that climbs above its own row (`$$.` at its top, `$$$.`
 *  one array down, …); each null when there is none. */
export const clampRefs = (
  condition: Condition,
): { bare: string | null; escaping: string | null } => {
  let bare: string | null = null;
  let escaping: string | null = null;
  visitCondition<number>(
    condition,
    (node, depth) => {
      if (isLogicalNode(node)) return;
      const values = valueRefs(node);
      for (const ref of [...(typeof node.field === 'string' ? [node.field] : []), ...values]) {
        const scoped = parseScopeRef(ref);
        if (escaping === null && scoped && scoped.depth > depth) escaping = ref;
      }
      for (const ref of values) if (bare === null && !parseScopeRef(ref)) bare = ref;
      return isRelationNode(node) ? depth + 1 : undefined;
    },
    1,
  );
  return { bare, escaping };
};

/** The models a visit's relation path passes through from the lens anchor, the visit's own last;
 *  null when the path doesn't lead from the anchor to it (an off-path visit). */
const visitTrail = (policy: Policy, at: MapVisit): MapVisit[] | null => {
  const anchor = { mapName: policy.lens.mapName, modelName: policy.lens.model, relPath: [] };
  const trail: MapVisit[] = [anchor];
  if (at.relPath.length > 0)
    for (const hop of relationHops(policy.lens.maps, anchor, at.relPath.join('.')).hops)
      trail.push({ mapName: hop.map, modelName: hop.model, relPath: hop.relPath });
  const end = trail[trail.length - 1];
  return trail.length === at.relPath.length + 1 &&
    end.mapName === at.mapName &&
    end.modelName === at.modelName
    ? trail
    : null;
};

const follow = (
  node: ModelNarrowing | undefined,
  segments: readonly string[],
): ModelNarrowing | undefined => {
  let at = node;
  for (const seg of segments) at = own(at?.relations, seg);
  return at;
};

/**
 * The narrowing nodes one layer applies at a visit: each model default that reaches it — the
 * model's own, or a relation object of a model default above it on the path, outermost first —
 * and its path node under `root`.
 */
const layerNodes = (
  narrowing: LensNarrowing,
  at: MapVisit,
  trail: readonly MapVisit[] | null,
): { defaults: ModelNarrowing[]; path: ModelNarrowing | undefined } => {
  const dflt = (visit: MapVisit) =>
    own(own(narrowing.mapDefaults, visit.mapName)?.models, visit.modelName);
  if (!trail) {
    const intrinsic = dflt(at);
    return { defaults: intrinsic ? [intrinsic] : [], path: undefined };
  }
  const defaults: ModelNarrowing[] = [];
  for (const [k, visit] of trail.entries()) {
    const node = follow(dflt(visit), at.relPath.slice(k));
    if (node) defaults.push(node);
  }
  return { defaults, path: follow(narrowing.root, at.relPath) };
};

// The relations the model defaults turn on below one spelled node (the anchor, or a path spelled
// under `root`): for each node of the tree, keyed by its relation path below the spelled node,
// the relations it crosses.
type DefaultTree = Map<string, string[]>;

/**
 * The tree the first narrowing's model defaults grow under a spelled node: breadth-first, each
 * model at most once — at its nearest reach, ties to the earlier parent and then the relation
 * declared first — never one already on the spelled path. Its own `omits` cut an edge; a relation
 * the spelled node spells is not a tree edge (the spelled path follows it). Computed once per
 * spelled node and API call.
 */
const defaultTree = (
  lens: Lens,
  origin: LensNarrowing,
  spelled: MapVisit,
  byNode: Map<string, DefaultTree>,
): DefaultTree => {
  const node = follow(origin.root, spelled.relPath);
  const key = [
    spelled.relPath.join(SEP),
    Object.keys(node?.relations ?? {}).join(SEP),
    (node?.omits ?? []).join(SEP),
  ].join(`${SEP}${SEP}`);
  const cached = byNode.get(key);
  if (cached) return cached;
  const tree: DefaultTree = new Map();
  const policy: Policy = { lens, chain: [origin], origin };
  const trail = visitTrail(policy, spelled) ?? [spelled];
  const seen = new Set(trail.map((visit) => `${visit.mapName}:${visit.modelName}`));
  const queue: { at: MapVisit; below: string[] }[] = [{ at: spelled, below: [] }];
  while (queue.length > 0) {
    const { at, below } = queue.shift() as (typeof queue)[number];
    const fields = modelOf(own(lens.maps, at.mapName), at.modelName)?.fields ?? {};
    const { defaults, path } = layerNodes(origin, at, visitTrail(policy, at));
    const turnedOn = new Set(defaults.flatMap((node) => Object.keys(node.relations ?? {})));
    const omitted = new Set(
      [...defaults, ...(path ? [path] : [])].flatMap((node) => node.omits ?? []),
    );
    const crossed: string[] = [];
    for (const [relation, entry] of Object.entries(fields)) {
      if (!turnedOn.has(relation) || omitted.has(relation)) continue;
      if (path?.relations !== undefined && Object.hasOwn(path.relations, relation)) continue;
      const target = relationTargetOf(entry, at.mapName);
      if (!target || !modelOf(own(lens.maps, target.mapName), target.modelName)) continue;
      const model = `${target.mapName}:${target.modelName}`;
      if (seen.has(model)) continue;
      seen.add(model);
      crossed.push(relation);
      queue.push({
        at: { ...target, relPath: [...at.relPath, relation] },
        below: [...below, relation],
      });
    }
    tree.set(below.join('.'), crossed);
  }
  byNode.set(key, tree);
  return tree;
};

/** The relations the first narrowing turns on at a visit: those its path spells there, and the
 *  default-tree edges below the nearest spelled node. */
const turnedOnAt = (
  policy: Policy,
  origin: LensNarrowing,
  at: MapVisit,
  trail: readonly MapVisit[] | null,
): string[] => {
  // Off the anchor's paths (a model's own visit), its defaults' relations — no tree applies.
  if (!trail)
    return layerNodes(origin, at, null).defaults.flatMap((node) =>
      Object.keys(node.relations ?? {}),
    );
  let spelledDepth = at.relPath.length;
  while (spelledDepth > 0 && follow(origin.root, at.relPath.slice(0, spelledDepth)) === undefined)
    spelledDepth--;
  const spelledAt = { ...trail[spelledDepth], relPath: at.relPath.slice(0, spelledDepth) };
  const tree = defaultTree(policy.lens, origin, spelledAt, policy.memo?.trees ?? new Map());
  const below = tree.get(at.relPath.slice(spelledDepth).join('.')) ?? [];
  const spelled =
    spelledDepth === at.relPath.length
      ? Object.keys(follow(origin.root, at.relPath)?.relations ?? {})
      : [];
  return [...spelled, ...below];
};

/** The first relation a path crosses from a visit that is not shown there (off, or omitted), as
 *  its dotted prefix; null when every relation it crosses is shown. Columns are not its concern. */
export const hiddenHop = (policy: Policy, from: MapVisit, path: string): string | null => {
  let at = from;
  for (const hop of relationHops(policy.lens.maps, from, path).hops) {
    const relation = hop.relPath[hop.relPath.length - 1];
    if (!resolveVisit(policy, at.mapName, at.modelName, at.relPath).relations.has(relation))
      return hop.prefix;
    at = { mapName: hop.map, modelName: hop.model, relPath: hop.relPath };
  }
  return null;
};

export const resolveVisit = (
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): VisitEffect => {
  const key = policy.memo ? visitKey(policy, mapName, modelName, relPath) : null;
  const kept = key === null ? undefined : policy.memo?.effects.get(key);
  if (kept) {
    // Resolved unvetted earlier: vetted, its later clamps are checked now, as a fresh resolve would.
    if (!policy.unvetted && kept.unchecked) {
      for (const check of kept.unchecked) check();
      kept.unchecked = null;
    }
    return kept.effect;
  }
  const unchecked: (() => void)[] = [];
  const out: VisitEffect = {
    picks: null,
    omits: new Set(),
    enumValuesByField: new Map(),
    whereClauses: [],
    sources: new Map(),
    sourceWheres: new Map(),
    sourceLabels: new Map(),
    sourceGroupBys: new Map(),
    sourceDeclaredAt: new Map(),
    sourcesFromMapDefaults: new Map(),
    relations: new Set(),
    relationFields: new Set(),
  };

  const fieldMap: FieldMap | undefined = own(policy.lens.maps, mapName);
  const model = modelOf(fieldMap, modelName);
  if (!model) return out;
  let fields = policy.memo?.models.get(model);
  if (!fields) {
    fields = modelFields(model);
    policy.memo?.models.set(model, fields);
  }
  out.relationFields = fields.relations;
  const at = { mapName, modelName, relPath };
  const origin = policy.origin ?? policy.chain[0];
  const placeKey = `${idOrNone(origin)}${SEP}${mapName}${SEP}${modelName}${SEP}${relPath.join(SEP)}`;
  let place = policy.memo?.places.get(placeKey);
  if (!place) {
    const trail = visitTrail(policy, at);
    place = { trail, turnedOn: origin ? turnedOnAt(policy, origin, at, trail) : [] };
    policy.memo?.places.set(placeKey, place);
  }
  const { trail } = place;

  const fieldEnumPicks = new Map<string, Set<string>>();
  const fieldEnumOmits = new Map<string, Set<string>>();
  const typeEnumPicks = new Map<string, Set<string>>();
  const typeEnumOmits = new Map<string, Set<string>>();

  // A layer's own conditions read through its parent: the relations they reach carry the
  // clamps of every layer above, as a user rule's do — a child can't see what its parent hides.
  let narrow = (condition: Condition): Condition => condition;
  let current = 0;
  let vet: (condition: Condition, source?: boolean) => void = () => {};
  let clamps = true;
  let hiding = true;
  const applyNode = (n: ModelDefaultNarrowing | ModelNarrowing): void => {
    accumulateInto(out, n, narrow, current, vet, clamps, hiding);
    accumulateEnumFields(fieldEnumPicks, fieldEnumOmits, n);
  };

  for (const [layer, narrowing] of policy.chain.entries()) {
    current = layer;
    // A later layer's clamps read through every layer above it, a pointer's included.
    const parent: Policy = {
      ...policy,
      clamp: false,
      skipClampsOf: undefined,
      skipHidingOf: undefined,
      chain: policy.chain.slice(0, layer),
    };
    clamps = narrowing !== policy.skipClampsOf;
    hiding = narrowing !== policy.skipHidingOf;
    narrow = (condition) =>
      layer === 0 ? condition : narrowAt(condition, parent, { mapName, modelName, relPath });
    for (const [enumName, enumN] of Object.entries(
      own(narrowing.mapDefaults, mapName)?.enums ?? {},
    )) {
      if (enumN.picks) intersectIntoMap(typeEnumPicks, enumName, enumN.picks);
      if (enumN.omits) unionIntoMap(typeEnumOmits, enumName, enumN.omits);
    }
    const { defaults, path } = layerNodes(narrowing, at, trail);
    // A clamp refused at construction (validateNarrowing) is refused here too, never applied.
    const clampParent: Policy | null = layer === 0 ? null : parent;
    const vetClamp =
      (rootClamp: boolean) =>
      (condition: Condition, source = false): void => {
        let refs = policy.memo?.refs.get(condition);
        if (!refs) {
          refs = clampRefs(condition);
          policy.memo?.refs.set(condition, refs);
        }
        // Only the root `where` stands on the root row; a source's eligibility reads option rows.
        if (refs.bare !== null && !(rootClamp && !source)) throw misanchoredPath(refs.bare);
        if (refs.escaping !== null) throw escapingClampRef(refs.escaping);
        if (!clampParent) return;
        const check = (): void => {
          const key =
            typeof condition === 'object' && condition !== null
              ? `${idOf(condition)}${SEP}${visitKey(clampParent, mapName, modelName, relPath)}`
              : null;
          if (key !== null && clampParent.memo?.vetted.has(key)) return;
          const [issue] = laterClampIssues(condition, clampParent, at);
          if (issue) throw unshownClamp(issue);
          if (key !== null) clampParent.memo?.vetted.add(key);
        };
        if (policy.unvetted) unchecked.push(check);
        else check();
      };
    vet = vetClamp(false);
    for (const node of defaults) applyNode(node);
    if (path) {
      vet = vetClamp(relPath.length === 0 && trail !== null);
      applyNode(path);
    }
  }
  // The first narrowing over the base lens turns relations on — the base is the menu — along its
  // spelled paths and the model-default tree below each; a later layer only narrows what it
  // inherits. exposedₖ = exposedₖ₋₁ ∧ ¬hideₖ.
  if (origin && policy.chain.includes(origin))
    for (const relation of place.turnedOn)
      if (out.relationFields.has(relation) && !out.omits.has(relation)) out.relations.add(relation);

  for (const [fieldName, entry] of fields.gated) {
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

  if (key !== null)
    policy.memo?.effects.set(key, { effect: out, unchecked: unchecked.length ? unchecked : null });
  return out;
};

// A visit's key in a call's resolved visits: the visit, and every part of the policy its effect
// reads — the layers (by identity), the first of them, and the layers it skips. Vetting is not a
// part: an unvetted resolve keeps the checks it skipped, for a vetted one to make.
const visitKey = (
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): string => {
  let layers = LAYERS_KEY.get(policy);
  if (layers === undefined) {
    layers = `${idOrNone(policy.origin)}${SEP}${idOrNone(policy.skipClampsOf)}${SEP}${idOrNone(policy.skipHidingOf)}${SEP}`;
    for (const layer of policy.chain) layers += `${idOf(layer)},`;
    LAYERS_KEY.set(policy, layers);
  }
  return `${layers}${SEP}${mapName}${SEP}${modelName}${SEP}${relPath.join(SEP)}`;
};
// A policy's layers part of its visit keys, per policy object (one is never edited once built).
const LAYERS_KEY = new WeakMap<Policy, string>();

/** A visit the lens shows: its dotted path from the anchor model, and its effect. */
export type ShownVisit = { path: string; at: MapVisit; effect: VisitEffect };

/**
 * Every visit the lens shows, from its anchor, along the relations turned on: the spelled paths
 * and the model-default tree under each — at most spelled nodes × models visits.
 */
export const shownVisits = (policy: Policy): ShownVisit[] => {
  const out: ShownVisit[] = [];
  const visit = (at: MapVisit, path: string): void => {
    const fieldMap = own(policy.lens.maps, at.mapName);
    if (!modelOf(fieldMap, at.modelName)) return;
    const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
    out.push({ path, at, effect });
    for (const relation of effect.relations) {
      const entry = fieldOf(fieldMap, at.modelName, relation);
      const target = entry && relationTargetOf(entry, at.mapName);
      if (target) visit({ ...target, relPath: [...at.relPath, relation] }, `${path}.${relation}`);
    }
  };
  visit(
    { mapName: policy.lens.mapName, modelName: policy.lens.model, relPath: [] },
    policy.lens.model,
  );
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
): LensRefusal =>
  new LensRefusal(
    `source '${field}' at '${path}' offers mapDefaults.${mapName}.models.${modelName}.sources.${field}, which no layer declares`,
    'invalid_source',
  );

/** Whether a visit shows a field: a relation when it is turned on there, a column when the picks
 *  keep it; omitted, neither. */
export const isFieldVisible = (effect: VisitEffect, fieldName: string): boolean => {
  if (effect.omits.has(fieldName)) return false;
  if (effect.relationFields.has(fieldName)) return effect.relations.has(fieldName);
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
 * the narrowing does not expose at this visit — a column it doesn't keep, or a relation it doesn't
 * turn on (or omits); `missing` is a field the model does not have (or a model the map does not
 * have); `pastScalar` is a segment after a scalar. A path that continues below a Json column
 * resolves at the column with the remainder in `jsonSubPath`.
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
    // A clamp may cross any relation not omitted, turned on or not.
    const visible =
      policy.clamp && isRelationEntry(entry)
        ? !effect.omits.has(fieldName)
        : isFieldVisible(effect, fieldName);
    if (!visible) return { resolution: { outcome: 'hidden', index: i, hops }, effects };
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
 * Whether a source's label or axes, as in force at a visit, cross only relations the lens declares
 * there and read only columns every layer but their earliest declaration shows. The declaring
 * layer may source a column it hides itself; any other layer that hides it — an ancestor, or a
 * layer after — drops it, so re-declaring an ancestor's label never revives what a layer in
 * between hid. A path that doesn't resolve stays, for the compile to refuse.
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
  const from = effect.sourceDeclaredAt.get(declaredKey(field, kind, value));
  const shown = (reader: Policy, path: string): boolean =>
    resolvePolicyPath(reader, at, path).resolution.outcome !== 'hidden';
  // Skipping a layer's hiding only shows more: what every layer shows needs no second read.
  const all: Policy = { ...policy, clamp: true };
  const others: Policy = {
    ...all,
    skipHidingOf: from === undefined ? undefined : policy.chain[from],
  };
  return (typeof value === 'string' ? [value] : value).every(
    (path) => hiddenHop(policy, at, path) === null && (shown(all, path) || shown(others, path)),
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

/** The issue for a path `lensPathEnd` refuses: `message`, or — when it stops at a relation the lens
 *  doesn't turn on — how to turn it on. */
export const unresolvedIssue = (
  policy: Policy,
  from: MapVisit,
  path: string,
  message: string,
): { code: 'not_in_lens'; message: string } => {
  const { resolution } = resolvePolicyPath(policy, from, path);
  if (resolution.outcome !== 'hidden') return { code: 'not_in_lens', message };
  const segments = path.split('.');
  const at = resolution.hops.at(-1);
  const visit = at
    ? { mapName: at.mapName, modelName: at.model, relPath: [...at.relPath, at.field] }
    : from;
  const target = at && relationTargetOf(at.entry, at.mapName);
  const reached = target ? { ...target, relPath: visit.relPath } : from;
  const effect = resolveVisit(policy, reached.mapName, reached.modelName, reached.relPath);
  const field = segments[resolution.index];
  if (!effect.relationFields.has(field) || effect.omits.has(field))
    return { code: 'not_in_lens', message };
  return {
    code: 'not_in_lens',
    message: `'${segments.slice(0, resolution.index + 1).join('.')}' is a relation the lens does not turn on (turn it on with \`relations\`)`,
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
  | {
      issue: {
        code: 'scope_out_of_bounds' | 'not_in_lens';
        message: string;
      };
    } => {
  const target = readScopeRef(field, scopes);
  if ('outOfBounds' in target)
    return { issue: { code: 'scope_out_of_bounds', message: target.outOfBounds } };
  if (target.scope.open) return { from: target.scope, next: target.scope, walked: null };
  const walked = lensPathEnd(policy, target.scope, target.path);
  if (!walked)
    return {
      issue: unresolvedIssue(
        policy,
        target.scope,
        target.path,
        'path does not resolve through the narrowed lens',
      ),
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
 * The relations a path crosses from a visit, read from the field maps — clamps apply to a relation
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
