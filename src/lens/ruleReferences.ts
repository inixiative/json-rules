import { own } from '../own';
import type { FieldMap } from '../toPrisma/types.ts';
import type { Condition, RuleValue } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { ruleLeafValues } from './ruleLeafValues.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * A row a rule names, and the values it named it by. `model`/`field` are where the FIELD
 * sits — the child for a foreign key — while `referencedModel` is whose row is named. For a
 * foreign key those differ (`FanMissions.brandMissionUuid` names a `BrandMissions` row); for
 * an identity reached through a relation they coincide (`…group.uuid` names a `Groups` row).
 */
export type RuleReference = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  referencedModel: string;
  /** Every literal a leaf at this field named; list operators flattened, deduped by content. */
  values: RuleValue[];
  /**
   * The rows cannot be enumerated: a leaf took its value from `path` / `bind`, or used an
   * operator that describes values without naming them. A caller deciding anything from
   * `values` must fail closed — an empty list here does NOT mean "references nothing".
   */
  dynamic: boolean;
};

/** Fields other rows point AT, per model — `Model.field` keys built from every relation's
 *  `(type, toFields)` pair. A leaf landing on one of these names a row of that model.
 *
 *  why: composite keys are skipped. One column of a two-column key does not name a row, and
 *  reporting it would hand the caller a uuid that identifies a set rather than a record. */
const identityCache = new WeakMap<FieldMap, Set<string>>();

const identityFields = (fieldMap: FieldMap): Set<string> => {
  const cached = identityCache.get(fieldMap);
  if (cached) return cached;
  const out = new Set<string>();
  for (const model of Object.values(fieldMap.models)) {
    for (const entry of Object.values(model.fields)) {
      if (entry.kind !== 'object' && entry.kind !== 'bridge') continue;
      if (entry.toFields?.length !== 1) continue;
      out.add(`${entry.type}.${entry.toFields[0]}`);
    }
  }
  identityCache.set(fieldMap, out);
  return out;
};

/** The model a foreign key on `modelName` points to, or undefined when the field is not one. */
const foreignKeyTarget = (
  fieldMap: FieldMap,
  modelName: string,
  fieldName: string,
): string | undefined => {
  const model = own(fieldMap.models, modelName);
  if (!model) return undefined;
  for (const entry of Object.values(model.fields)) {
    if (entry.kind !== 'object' && entry.kind !== 'bridge') continue;
    // why: single-column keys only — see identityFields. A leaf on one half of a composite
    // why: key names no row on its own.
    if (entry.fromFields?.length === 1 && entry.fromFields[0] === fieldName) return entry.type;
  }
  return undefined;
};

/**
 * Which ROWS a rule names, asked of the schema rather than declared by the caller. A field
 * names a row when it is a foreign key (the relation's `fromFields`) or the identity another
 * row would point at (some relation's `toFields`) — both facts the field map already carries,
 * so no lens author has to restate them and no consumer has to keep a hand-written table of
 * "which picks are references".
 *
 * This is deliberately NOT `ruleSourceValues`. That answers "which values does this rule name
 * at each declared SOURCE", and a source exists to supply a picker's vocabulary — declaring one
 * commits the lens to fetching that vocabulary. A reference needs no vocabulary: a rule can name
 * a row whose option set is supplied out of band, or not offered in a picker at all. Asking the
 * two questions through one mechanism forces a scan nobody wanted, so they stay separate.
 *
 * Policy stays with the caller: every foreign key answers here, including the ones a consumer
 * does not track (a tenant key, an owner back-pointer). Filter by `referencedModel`.
 */
export const ruleReferences = (
  lensOrNarrowing: Lens | LensNarrowing,
  rule: Condition,
): RuleReference[] => {
  const policy = resolvePolicy(lensOrNarrowing);

  return ruleLeafValues(policy, rule, (leaf) => {
    // why: resolved per leaf, never once from the root map — a bridge relation crosses maps, so
    // why: a leaf's identity set must come from the map the leaf actually landed in.
    const fieldMap = policy.lens.maps[leaf.mapName];
    if (!fieldMap) return undefined;
    const referencedModel =
      foreignKeyTarget(fieldMap, leaf.model, leaf.field) ??
      (identityFields(fieldMap).has(`${leaf.model}.${leaf.field}`) ? leaf.model : undefined);
    return referencedModel ? { referencedModel } : undefined;
  });
};
