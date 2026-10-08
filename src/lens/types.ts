import type { FieldMapSet } from '../fieldMap/types.ts';
import type { Condition } from '../types.ts';

export type Lens = FieldMapSet & {
  mapName: string; // which map in `maps` the anchor model lives in
  model: string;
};

/**
 * Narrowing applied wherever a model appears (intrinsic to the model).
 *
 * Two kinds of narrowing live here:
 * - SCHEMA narrowing (picks/omits/enumPicks/enumOmits, relations): controls what's visible in the
 *   type surface. AI/SDK consumers can't see narrowed-away fields. `picks` names columns only;
 *   a relation is a field turned on through `relations`.
 * - DATA narrowing (where): controls which ROWS are in scope. Filter-first
 *   semantic, anchored to the model. Under arrayOperator: 'all', it becomes the window filter
 *   (filter-first) — see narrowRule.
 */
export type ModelDefaultNarrowing = {
  picks?: string[];
  omits?: string[];
  enumPicks?: Record<string, readonly string[]>; // fieldName → allowed enum values
  enumOmits?: Record<string, readonly string[]>; // fieldName → denied enum values
  /**
   * Row-level filter anchored to this model — "from what you can see, this is true."
   * Composes via filter-first semantic at every visit of this model.
   */
  where?: Condition;
  /**
   * Per-field eligibility over THIS model — decorates a field's option picker.
   * A bare `Condition` is the eligibility `where`: the field's selectable values =
   * DISTINCT(field) over this model filtered by `where` (plus the model's own
   * narrowing). A `SourceSpec` adds an optional `label` — a sibling column, or a
   * dotted to-one path ending on a scalar (like `groupBy`), co-selected as each
   * value's display label. Referenced-model option sets need no special form: declare
   * the source at a relation-traversed narrowing node and it compiles over whatever
   * model that path resolves to. The `where` composes AND-only across layers (general
   * via `mapDefaults`, path-specific via `root`/`relations`); a later layer's `label` wins.
   */
  sources?: Record<string, SourceEntry>; // fieldName → eligibility where | SourceSpec
  /**
   * Relations are fields, off by default. A key here turns that relation on at this node — on a
   * path node, at that visit; on a model default, wherever the model is visited — and its value is
   * that hop's narrowing (`where`, `picks`/`omits` of the target's columns, further `relations`).
   * Only the first narrowing over the base lens turns a relation on; a later layer may only narrow
   * one its parent shows. Model-default turn-ons grow a tree under each spelled node: each model
   * once, at its nearest reach; reach it another way by spelling the path under `root`. The first narrowing's grants (`where`) may read any
   * relation; a later layer's only what its parent shows.
   */
  relations?: Record<string, ModelNarrowing>;
};

/**
 * A sourced field's eligibility `where` plus an optional display-label column — a
 * sibling, or a dotted to-one path ending on a scalar, resolved exactly like a
 * `groupBy` axis — and an optional `groupBy`: a dotted path (to-one hops only, ending
 * on a scalar) whose value partitions the option set. Grouped options carry `group`;
 * the classic flat set is the ungrouped case. At least one key is required — `{}` is not a
 * Condition; the unconstrained spelling is `true`.
 */
export type SourceSpec =
  | { where: Condition; label?: string; groupBy?: string | string[]; from?: never }
  | { where?: Condition; label: string; groupBy?: string | string[]; from?: never }
  | { where?: Condition; label?: string; groupBy: string | string[]; from?: never }
  /** A path source that offers its model's own source — `mapDefaults[map].models[model]
   *  .sources[field]` for the map and model this path reaches — instead of the rows reachable
   *  down the path. Its label and axes are the model source's; its `where` can only narrow. */
  | { from: 'mapDefaults'; where?: Condition; label?: never; groupBy?: never };

/** A `sources` entry: a bare eligibility `Condition`, or a richer `SourceSpec`. */
export type SourceEntry = Condition | SourceSpec;

/** Narrowing for a model at a specific traversal path: the same shape as a model default. */
export type ModelNarrowing = ModelDefaultNarrowing;

/** Narrowing for an enum type (applies anywhere the enum is referenced). */
export type EnumNarrowing = {
  picks?: readonly string[];
  omits?: readonly string[];
};

/** Applies-everywhere narrowings for one map — per-model + per-enum-type. */
export type NarrowingDefaults = {
  models?: Record<string, ModelDefaultNarrowing>;
  enums?: Record<string, EnumNarrowing>;
};

export type LensNarrowing = {
  // The composed form: the layer above as an object. A database stores layers as StoredLens records.
  parent: Lens | LensNarrowing;
  /**
   * Path-specific narrowing anchored at (lens.mapName, lens.model). Descends via `.relations` —
   * which turns those relations on — and may cross maps through bridge relations.
   */
  root?: ModelNarrowing;
  /**
   * Per-map applies-everywhere narrowings, keyed by map name. Apply wherever the
   * named model/enum appears in the visit being resolved.
   */
  mapDefaults?: Record<string, NarrowingDefaults>;
};
