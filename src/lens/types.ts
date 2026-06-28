import type { FieldMapSet } from '../fieldMap/types.ts';
import type { Condition } from '../types.ts';

export type Lens = FieldMapSet & {
  mapName: string; // which map in `maps` the anchor model lives in
  model: string;
};

/**
 * Narrowing applied wherever a model appears (intrinsic to the model).
 * Has no `relations` because relations are path-specific by definition.
 *
 * Two kinds of narrowing live here:
 * - SCHEMA narrowing (picks/omits/enumPicks/enumOmits): controls what's visible
 *   in the type surface. AI/SDK consumers can't see narrowed-away fields.
 * - DATA narrowing (where): controls which ROWS are in scope. Filter-first
 *   semantic, anchored to the model. Under arrayOperator: 'all', applied via
 *   implication (negate) to preserve filter-first meaning — see applyLens.
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
   * Per-field eligibility `where` over THIS model — decorates a field's option
   * picker. The field's selectable values = DISTINCT(field) over this model
   * filtered by `where` (plus the model's own narrowing). Composes like `where`:
   * general via `mapDefaults`, path-specific via `root`/`relations`, AND-only.
   */
  sources?: Record<string, Condition>; // fieldName → eligibility where
};

/** Narrowing for a model at a specific traversal path. Adds relations to the default shape. */
export type ModelNarrowing = ModelDefaultNarrowing & {
  relations?: Record<string, ModelNarrowing>;
};

/** Narrowing for an enum type (applies anywhere the enum is referenced). */
export type EnumNarrowing = {
  picks?: readonly string[];
  omits?: readonly string[];
};

/** Applies-everywhere narrowings for one map — per-model (no relations) + per-enum-type. */
export type NarrowingDefaults = {
  models?: Record<string, ModelDefaultNarrowing>;
  enums?: Record<string, EnumNarrowing>;
};

export type LensNarrowing = {
  // TODO: may need to be an identifier (lens name/uuid) rather than a direct reference for persistence
  parent: Lens | LensNarrowing;
  /**
   * Path-specific narrowing anchored at (lens.mapName, lens.model). Descends via
   * `.relations` and may cross maps through bridge relations.
   */
  root?: ModelNarrowing;
  /**
   * Per-map applies-everywhere narrowings, keyed by map name. Apply wherever the
   * named model/enum appears in the visit being resolved.
   */
  mapDefaults?: Record<string, NarrowingDefaults>;
};
