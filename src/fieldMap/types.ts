/** A selectable option — the standard `<select>` shape: a value with an optional display
 * label, plus the partition keys (index-aligned with the source's `groupBy` axes)
 * when the source is grouped. */
export type SourceOption = { value: string; label?: string; groups?: string[] };

// FieldMap is structurally compatible with PrismaMap from @inixiative/prisma-map.
// It only requires the fields that json-rules needs for traversal.
export type FieldMapEntry = {
  kind: 'scalar' | 'object' | 'enum' | 'bridge';
  type: string;
  isList?: boolean;
  /**
   * Whether the column is NOT NULL. `toPrisma` reads this to decide if a negated
   * operator needs an explicit `equals: null` arm (Prisma's `not`/`notIn` follow SQL
   * three-valued logic and drop NULL rows); absent = unknown = no arm.
   */
  isRequired?: boolean;
  fromFields?: string[];
  toFields?: string[];
  relationName?: string; // disambiguates multiple relations between same two models
  /**
   * Per-field allowed values, primarily for enum fields. Takes precedence over
   * `FieldMap.enums[type]` if both are set. Pass-through from codegen
   * (e.g. prisma-map's `EnumField.values`). Consumed by `validateRuleInLens`.
   */
  values?: readonly string[];
  /**
   * A field's selectable option set as `{ value, label? }` pairs — the display
   * shape a picker consumes. On projection/surface output this is populated for
   * every value-gated field (enum members normalized to `{ value, label: value }`)
   * and for sourced fields (the fetched pairs from a materialized `SourceValues`).
   */
  options?: readonly SourceOption[];
  /**
   * Present on projection/surface output when the field's source partitions its
   * options: the dotted to-one axes (relative to this model) whose values are
   * each option's `groups`, index-aligned.
   */
  groupBy?: readonly string[];
};

export type ModelEntry = {
  dbName?: string | null;
  fields: Record<string, FieldMapEntry>;
};

/**
 * A schema map: models keyed by name, plus an optional enum registry scoped to
 * this source. In multi-source setups (Prisma + Salesforce + CRM) each FieldMap
 * carries its own enums so namespaces don't collide across sources.
 */
export type FieldMap = {
  models: Record<string, ModelEntry>;
  /** Enum name → allowed values, e.g. `{ UserRole: ['ADMIN', 'USER'] }`. */
  enums?: Record<string, readonly string[]>;
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
  maps: Record<string, FieldMap>;
  bridges?: Bridge[];
};

// Enums live on each FieldMap (per-source). Access via `set.maps[mapName].enums[enumName]`.
