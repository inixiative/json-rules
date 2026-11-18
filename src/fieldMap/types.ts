import type { FieldEntry, ModelEntry } from '@inixiative/field-map';

/** A selectable option — the standard `<select>` shape: a value with an optional display
 * label, plus the partition keys (index-aligned with the source's `groupBy` axes)
 * when the source is grouped. */
export type SourceOption = { value: string; label?: string; groups?: string[] };

/** A relation across sources that `stitchFieldMaps` adds to each bridge endpoint's model, named
 *  after the other endpoint (`<fieldMap>:<Model>`). */
export type BridgeEntry = {
  readonly kind: 'bridge';
  readonly type: string;
  readonly isList?: boolean;
  readonly isRequired?: boolean;
};

/** What projection and surface output add to a field. */
type ProjectedFields = {
  /**
   * A field's selectable option set as `{ value, label? }` pairs — the display
   * shape a picker consumes. On projection/surface output this is populated for
   * every value-gated field (enum members normalized to `{ value, label: value }`)
   * and for sourced fields (the fetched pairs from a materialized `SourceValues`).
   */
  readonly options?: readonly SourceOption[];
  /**
   * Present on projection/surface output when the field's source partitions its
   * options: the dotted to-one axes (relative to this model) whose values are
   * each option's `groups`, index-aligned.
   */
  readonly groupBy?: readonly string[];
};

// What a lens reads off any field without narrowing first, absent meaning unknown: allowed values
// (an enum's, or a scalar's a hand-written map fixes) and a relation's keys and name.
type ReadableFields = {
  readonly values?: readonly string[];
  readonly fromFields?: readonly string[];
  readonly toFields?: readonly string[];
  readonly relationName?: string;
};

/** A field as a lens reads it: a schema field (`@inixiative/field-map`), or a bridge
 *  `stitchFieldMaps` added, with what a projection adds. */
export type FieldMapEntry = (FieldEntry | BridgeEntry) & ProjectedFields & ReadableFields;

/** A model as a lens reads it. */
export type LensModelEntry = Omit<ModelEntry, 'fields'> & {
  readonly fields: { readonly [field: string]: FieldMapEntry };
};

/**
 * The field map a lens reads: a schema map (`@inixiative/field-map`'s `FieldMap`, which is one),
 * with its bridges stitched in and, on projection output, its options. In multi-source setups
 * (Prisma + Salesforce + CRM) each map carries its own enums, so namespaces don't collide.
 */
export type LensFieldMap = {
  readonly models: { readonly [model: string]: LensModelEntry };
  readonly enums?: { readonly [enumName: string]: readonly string[] };
};

export type BridgeEndpoint = {
  fieldMap: string;
  model: string;
  on: string;
};

export type BridgeCardinality = 'oneToOne' | 'oneToMany';

/**
 * A cross-source edge between two endpoints.
 *
 * Endpoint ordering convention for `oneToMany`:
 *   - `endpoints[0]` is the "one" side — its `on` field must be unique per row
 *     (typically a primary key).
 *   - `endpoints[1]` is the "many" side — its `on` field may repeat across rows
 *     (typically a foreign key).
 *
 * Mis-ordering produces wrong `isList` flags during stitching and silent
 * row-dedup when building bridge dictionaries. `indexBridges` throws
 * at runtime if endpoint[0]'s data has duplicate `on` values to catch this.
 *
 * For `oneToOne`, both `on` fields must be unique; endpoint order is symmetric.
 */
export type Bridge = {
  endpoints: [BridgeEndpoint, BridgeEndpoint];
  cardinality: BridgeCardinality;
};

export type FieldMapSet = {
  maps: Record<string, LensFieldMap>;
  bridges?: Bridge[];
};

// Enums live on each FieldMap (per-source). Access via `set.maps[mapName].enums[enumName]`.
