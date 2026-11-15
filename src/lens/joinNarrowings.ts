import { isRelationEntry } from '../fieldMap/entry';
import type { FieldMapEntry } from '../fieldMap/types';
import { type MapVisit, relationTargetOf } from '../fieldMap/walk.ts';
import { modelOf, own } from '../own';
import { allOf, conjuncts } from '../traverse';
import type { Condition } from '../types.ts';
import { validateNarrowing } from './narrowing.ts';
import { narrowAt } from './narrowRule.ts';
import {
  isFieldVisible,
  LensRefusal,
  OFF_PATH,
  type Policy,
  resolvePolicy,
  resolveVisit,
  shownVisits,
  type VisitEffect,
} from './policy.ts';
import type {
  EnumNarrowing,
  Lens,
  LensNarrowing,
  ModelNarrowing,
  NarrowingDefaults,
} from './types.ts';

type Layer = Omit<LensNarrowing, 'parent'>;
type Lists = Record<string, readonly string[]>;

const refuse = (code: string, path: string, message: string): LensRefusal =>
  new LensRefusal(`joinNarrowings: ${path ? `${path}: ` : ''}${message}`, code, path);

// A condition with its object keys sorted, so equal conditions print equal.
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
  );
};
const print = (value: unknown): string => JSON.stringify(sorted(value));

const union = (a?: readonly string[], b?: readonly string[]): string[] | undefined =>
  a || b ? [...new Set([...(a ?? []), ...(b ?? [])])].sort() : undefined;
const meet = (a?: readonly string[], b?: readonly string[]): string[] | undefined =>
  a && b ? a.filter((x) => b.includes(x)).sort() : a || b ? [...(a ?? b ?? [])].sort() : undefined;

const perField = (
  a: Lists | undefined,
  b: Lists | undefined,
  combine: (x?: readonly string[], y?: readonly string[]) => string[] | undefined,
): Record<string, string[]> | undefined => {
  if (!a && !b) return undefined;
  const fields = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  return Object.fromEntries(fields.map((f) => [f, combine(own(a, f), own(b, f)) ?? []]));
};

// The later layer's `where`, read as the chain reads it: through the earlier layers' clamps on the
// relations it crosses (the narrowing resolveVisit applies to every layer after the first).
const readThrough = (where: Condition, earlier: Policy, at: MapVisit, path: string): Condition => {
  try {
    return narrowAt(where, earlier, at);
  } catch (error) {
    if (!(error instanceof LensRefusal)) throw error;
    throw refuse('unjoinable_clamp', path, error.message);
  }
};

const conjoin = (a: Condition | undefined, b: Condition | undefined): Condition | undefined =>
  a === undefined ? b : b === undefined ? a : allOf([...conjuncts(a), ...conjuncts(b)]);

// A node that narrows nothing: no selection, no clamp, no relation below it that narrows.
const inert = (node: ModelNarrowing): boolean =>
  node.picks === undefined &&
  !node.omits?.length &&
  node.where === undefined &&
  node.sources === undefined &&
  Object.keys(node.enumPicks ?? {}).length === 0 &&
  Object.values(node.enumOmits ?? {}).every((values) => values.length === 0) &&
  Object.values(node.relations ?? {}).every(inert);

const targetOf = (fields: Record<string, FieldMapEntry>, relation: string, mapName: string) => {
  const entry = own(fields, relation);
  return entry ? relationTargetOf(entry, mapName) : null;
};

/** Two layers' nodes at one place, the later read through the earlier: picks meet, omits and enum
 *  omits union, `where`s conjoin, relations merge by name. */
const joinNode = (
  lens: Lens,
  earlier: Policy,
  a: ModelNarrowing | undefined,
  b: ModelNarrowing | undefined,
  at: MapVisit,
  onPath: boolean,
  path: string,
): ModelNarrowing => {
  const fields = modelOf(own(lens.maps, at.mapName), at.modelName)?.fields ?? {};
  const out: ModelNarrowing = {};
  const picks = meet(a?.picks, b?.picks);
  const omits = union(a?.omits, b?.omits);
  if (picks) out.picks = picks;
  if (omits) out.omits = omits;
  const enumPicks = perField(a?.enumPicks, b?.enumPicks, meet);
  const enumOmits = perField(a?.enumOmits, b?.enumOmits, union);
  if (enumPicks) out.enumPicks = enumPicks;
  if (enumOmits) out.enumOmits = enumOmits;
  const later = b?.where === undefined ? undefined : readThrough(b.where, earlier, at, path);
  const where = conjoin(a?.where, later);
  if (where !== undefined) out.where = where;
  // A restatement that narrows nothing is dropped where the first layer didn't spell the relation:
  // kept, it would spell (or, at a model default, turn on) what the first layer reached otherwise.
  const relations = [
    ...new Set([
      ...Object.keys(a?.relations ?? {}),
      ...Object.entries(b?.relations ?? {})
        .filter(([, node]) => !inert(node))
        .map(([relation]) => relation),
    ]),
  ];
  if (relations.length) {
    out.relations = {};
    for (const relation of relations) {
      const target = targetOf(fields, relation, at.mapName);
      if (!target) continue;
      out.relations[relation] = joinNode(
        lens,
        earlier,
        own(a?.relations, relation),
        own(b?.relations, relation),
        { ...target, relPath: onPath ? [...at.relPath, relation] : OFF_PATH },
        onPath,
        `${path}.relations.${relation}`,
      );
    }
  }
  return out;
};

const joinEnums = (
  a: Record<string, EnumNarrowing> | undefined,
  b: Record<string, EnumNarrowing> | undefined,
): Record<string, EnumNarrowing> | undefined => {
  if (!a && !b) return undefined;
  const names = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
  return Object.fromEntries(
    names.map((name) => {
      const picks = meet(own(a, name)?.picks, own(b, name)?.picks);
      const omits = union(own(a, name)?.omits, own(b, name)?.omits);
      return [name, { ...(picks ? { picks } : {}), ...(omits ? { omits } : {}) }];
    }),
  );
};

/** Two layers as one: `b` narrows the lens `a` makes over `lens`. */
const joinPair = (lens: Lens, a: Layer, b: Layer): Layer => {
  const earlier = resolvePolicy({ parent: lens, ...a });
  const anchor = { mapName: lens.mapName, modelName: lens.model, relPath: [] };
  const out: Layer = {};
  if (a.root || b.root) out.root = joinNode(lens, earlier, a.root, b.root, anchor, true, 'root');
  const maps = [
    ...new Set([...Object.keys(a.mapDefaults ?? {}), ...Object.keys(b.mapDefaults ?? {})]),
  ];
  if (maps.length) out.mapDefaults = {};
  for (const mapName of maps) {
    const left = own(a.mapDefaults, mapName);
    const right = own(b.mapDefaults, mapName);
    const defaults: NarrowingDefaults = {};
    const models = [
      ...new Set([...Object.keys(left?.models ?? {}), ...Object.keys(right?.models ?? {})]),
    ];
    if (models.length) defaults.models = {};
    for (const modelName of models)
      (defaults.models as Record<string, ModelNarrowing>)[modelName] = joinNode(
        lens,
        earlier,
        own(left?.models, modelName),
        own(right?.models, modelName),
        { mapName, modelName, relPath: OFF_PATH },
        false,
        `mapDefaults.${mapName}.models.${modelName}`,
      );
    const enums = joinEnums(left?.enums, right?.enums);
    if (enums) defaults.enums = enums;
    (out.mapDefaults as Record<string, NarrowingDefaults>)[mapName] = defaults;
  }
  return out;
};

// One node's selection in the form one layer may write it: a column it both picks and omits is
// left out of the picks (a layer may not name both), and a path node names nothing its own
// layer's model default already hides — the default hides it at this visit either way.
const tidyNode = (
  lens: Lens,
  defaultsOnly: Policy,
  layer: Layer,
  node: ModelNarrowing,
  at: MapVisit,
  onPath: boolean,
): void => {
  const fields = modelOf(own(lens.maps, at.mapName), at.modelName)?.fields ?? {};
  const isRelation = (f: string) => {
    const entry = own(fields, f);
    return entry !== undefined && isRelationEntry(entry);
  };
  const dflt = onPath ? own(own(layer.mapDefaults, at.mapName)?.models, at.modelName) : undefined;
  const hiddenByDefault = (f: string) =>
    dflt !== undefined &&
    ((!isRelation(f) && dflt.picks !== undefined && !dflt.picks.includes(f)) ||
      (dflt.omits?.includes(f) ?? false));
  if (node.picks)
    node.picks = node.picks.filter((f) => !node.omits?.includes(f) && !hiddenByDefault(f));
  if (node.omits) {
    const omits = node.omits.filter(
      (f) => !hiddenByDefault(f) && (node.picks === undefined || isRelation(f)),
    );
    if (omits.length) node.omits = omits;
    else delete node.omits;
  }
  if (onPath && (node.enumPicks || node.enumOmits)) {
    const allowed = resolveVisit(
      defaultsOnly,
      at.mapName,
      at.modelName,
      at.relPath,
    ).enumValuesByField;
    for (const kind of ['enumPicks', 'enumOmits'] as const) {
      const lists = node[kind];
      if (!lists) continue;
      const kept: Record<string, string[]> = {};
      for (const [field, values] of Object.entries(lists)) {
        const shown = allowed.get(field);
        const next = shown ? values.filter((v) => shown.includes(v)) : [...values];
        if (next.length || kind === 'enumPicks') kept[field] = next;
      }
      if (Object.keys(kept).length) node[kind] = kept;
      else delete node[kind];
    }
  }
  for (const [relation, child] of Object.entries(node.relations ?? {})) {
    const target = targetOf(fields, relation, at.mapName);
    if (target)
      tidyNode(
        lens,
        defaultsOnly,
        layer,
        child,
        { ...target, relPath: onPath ? [...at.relPath, relation] : OFF_PATH },
        onPath,
      );
  }
};

const tidy = (lens: Lens, layer: Layer): Layer => {
  const defaultsOnly = resolvePolicy({ parent: lens, mapDefaults: layer.mapDefaults });
  for (const [mapName, defaults] of Object.entries(layer.mapDefaults ?? {}))
    for (const [modelName, node] of Object.entries(defaults.models ?? {}))
      tidyNode(lens, defaultsOnly, layer, node, { mapName, modelName, relPath: OFF_PATH }, false);
  if (layer.root)
    tidyNode(
      lens,
      defaultsOnly,
      layer,
      layer.root,
      { mapName: lens.mapName, modelName: lens.model, relPath: [] },
      true,
    );
  return layer;
};

// Keys sorted, and the parts that say nothing dropped: an empty `omits`, `relations`, model
// default, map entry or root. A node under `relations` stays even when empty: it turns a relation on.
const canonical = (layer: Layer): Layer => {
  const node = (n: ModelNarrowing, keep: boolean): ModelNarrowing | undefined => {
    const out: ModelNarrowing = {};
    if (n.enumOmits && Object.keys(n.enumOmits).length) out.enumOmits = n.enumOmits;
    if (n.enumPicks && Object.keys(n.enumPicks).length) out.enumPicks = n.enumPicks;
    if (n.omits?.length) out.omits = [...n.omits].sort();
    if (n.picks) out.picks = [...n.picks].sort();
    const relations = Object.keys(n.relations ?? {}).sort();
    if (relations.length)
      out.relations = Object.fromEntries(
        relations.map((r) => [r, node(own(n.relations, r) as ModelNarrowing, true) ?? {}]),
      );
    if (n.sources !== undefined) out.sources = n.sources;
    if (n.where !== undefined) out.where = n.where;
    return keep || Object.keys(out).length ? (sorted(out) as ModelNarrowing) : undefined;
  };
  const out: Layer = {};
  const mapDefaults: Record<string, NarrowingDefaults> = {};
  for (const mapName of Object.keys(layer.mapDefaults ?? {}).sort()) {
    const defaults = own(layer.mapDefaults, mapName) as NarrowingDefaults;
    const entry: NarrowingDefaults = {};
    const enums = Object.keys(defaults.enums ?? {})
      .sort()
      .flatMap((name) => {
        const e = own(defaults.enums, name) as EnumNarrowing;
        const kept: EnumNarrowing = {
          ...(e.omits?.length ? { omits: [...e.omits].sort() } : {}),
          ...(e.picks ? { picks: [...e.picks].sort() } : {}),
        };
        return Object.keys(kept).length ? [[name, kept] as const] : [];
      });
    if (enums.length) entry.enums = Object.fromEntries(enums);
    const models = Object.keys(defaults.models ?? {})
      .sort()
      .flatMap((name) => {
        const kept = node(own(defaults.models, name) as ModelNarrowing, false);
        return kept ? [[name, kept] as const] : [];
      });
    if (models.length) entry.models = Object.fromEntries(models);
    if (Object.keys(entry).length) mapDefaults[mapName] = entry;
  }
  if (Object.keys(mapDefaults).length) out.mapDefaults = mapDefaults;
  const root = layer.root && node(layer.root, false);
  if (root) out.root = root;
  return out;
};

// What one visit shows, in a form two lenses can be compared by: its columns, its relations, each
// enum's allowed values, and its clamps as one set of conjuncts.
const surfaceOf = (lens: Lens, at: MapVisit, effect: VisitEffect) => {
  const fields = modelOf(own(lens.maps, at.mapName), at.modelName)?.fields ?? {};
  return {
    columns: Object.keys(fields)
      .filter((f) => !effect.relationFields.has(f) && isFieldVisible(effect, f))
      .sort(),
    relations: [...effect.relations].sort(),
    enums: [...effect.enumValuesByField.entries()].sort(([x], [y]) => (x < y ? -1 : 1)),
    clamps: effect.whereClauses.flatMap(conjuncts).map(print).sort(),
  };
};

// The joined narrowing against the chain it stands for, visit by visit: anything that differs is a
// chain one narrowing can't hold.
const assertSameSurface = (lens: Lens, chain: LensNarrowing, joined: LensNarrowing): void => {
  const visits = (policy: Policy) =>
    new Map(shownVisits(policy).map((visit) => [visit.path, visit]));
  const before = visits(resolvePolicy(chain));
  const after = visits(resolvePolicy(joined));
  for (const [path, visit] of before) {
    const other = after.get(path);
    if (!other)
      throw refuse(
        'unjoinable_shape',
        path,
        'one narrowing would hide this visit: the chain reaches it, but the joined default-relation tree does not',
      );
    const want = surfaceOf(lens, visit.at, visit.effect);
    const got = surfaceOf(lens, other.at, other.effect);
    for (const part of ['columns', 'relations', 'enums', 'clamps'] as const)
      if (print(want[part]) !== print(got[part]))
        throw refuse(
          part === 'clamps' ? 'unjoinable_clamp' : 'unjoinable_shape',
          path,
          part === 'clamps'
            ? "the clamps here differ from the chain's: a later layer's model-default `where` reads through an earlier layer's path clamp, which applies at this visit but not wherever the model is visited, so no one `where` says what the chain does"
            : part === 'relations'
              ? 'one narrowing would show different relations here than the chain does: a later layer restates a relation where the first layer did not spell it (at a model default, which turns it on wherever the model is visited, or on a path the default-relation tree reached), or omits an edge of that tree, and the tree then reaches models another way'
              : `one narrowing would show different ${part} here than the chain does`,
        );
  }
  for (const path of after.keys())
    if (!before.has(path))
      throw refuse(
        'unjoinable_shape',
        path,
        'one narrowing would show this visit, which the chain hides: an omit or a restated relation changes which models the default-relation tree reaches',
      );
};

// Where a layer first declares sources, or null: a source's label and its `from: 'mapDefaults'`
// pointer are read per layer, so a layer with sources joins with nothing.
const sourcesAt = (layer: Layer): string | null => {
  const find = (node: ModelNarrowing | undefined, path: string): string | null => {
    if (!node) return null;
    if (node.sources !== undefined) return `${path}.sources`;
    for (const [relation, child] of Object.entries(node.relations ?? {})) {
      const found = find(child, `${path}.relations.${relation}`);
      if (found) return found;
    }
    return null;
  };
  for (const [mapName, defaults] of Object.entries(layer.mapDefaults ?? {}))
    for (const [modelName, node] of Object.entries(defaults.models ?? {})) {
      const found = find(node, `mapDefaults.${mapName}.models.${modelName}`);
      if (found) return found;
    }
  return find(layer.root, 'root');
};

/**
 * One narrowing over `lens` equal to the chain `layers` make, each written over the lens the ones
 * before it produce (`{ parent: { parent: lens, ...layers[0] }, ...layers[1] }`). Picks meet, omits
 * and enum omits union, `where`s conjoin flat in layer order (a later one read through the earlier
 * layers' clamps on what it crosses), relations stay the first layer's. Deterministic: keys and
 * lists are sorted. Refuses, with a `LensRefusal` naming the path, an invalid layer and every chain
 * no single narrowing can hold, rather than approximate one.
 */
export const joinNarrowings = (lens: Lens, layers: readonly Layer[]): Layer => {
  let chain: Lens | LensNarrowing = lens;
  for (const [index, layer] of layers.entries()) {
    if (Object.hasOwn(layer, 'parent'))
      throw refuse('invalid_layer', `layers.${index}`, 'a layer is written without its parent');
    const next: LensNarrowing = { ...layer, parent: chain };
    const [issue] = validateNarrowing(next).errors;
    if (issue)
      throw refuse(
        issue.code,
        `layers.${index}${issue.path ? `.${issue.path}` : ''}`,
        issue.message,
      );
    chain = next;
  }
  const said = layers.filter((layer) => Object.keys(canonical(layer)).length > 0);
  const [first = {}, ...rest] = said;
  let joined = canonical(first);
  for (const layer of rest) {
    const later = sourcesAt(layer);
    if (later) throw refuse('unjoinable_sources', later, 'a later layer declares sources');
    const declared = sourcesAt(joined);
    if (declared) throw refuse('unjoinable_sources', declared, 'an earlier layer declares sources');
    joined = canonical(tidy(lens, joinPair(lens, joined, layer)));
  }
  if (rest.length) {
    const [issue] = validateNarrowing({ parent: lens, ...joined }).errors;
    if (issue) throw refuse('unjoinable_shape', issue.path, issue.message);
    assertSameSurface(lens, chain as LensNarrowing, { parent: lens, ...joined });
  }
  return joined;
};
