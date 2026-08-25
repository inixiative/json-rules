import { type ConditionNode, isRelationNode, mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

type Segments = readonly string[];

/**
 * The one path primitive: a node's `field` consumes leading segments of the remaining
 * fieldPath, or null when it names something else. Both spellings reduce to it — descent
 * keeps the remainder, and a leaf MATCH is full consumption (empty remainder).
 */
const consume = (path: Segments, field: string): Segments | null => {
  const parts = field.split('.');
  if (parts.length > path.length) return null;
  for (let i = 0; i < parts.length; i++) if (parts[i] !== path[i]) return null;
  return path.slice(parts.length);
};

/**
 * Relation descent: the relation's `field` consumes its segments; a relation with no
 * `field` (a root array) consumes none and is walked THROUGH — the callers are gates, and
 * a missed reference is the dangerous direction. Non-relation nodes never scope children
 * to a row, so their `condition` / `filter` are pruned for field-path purposes.
 */
const descendByFieldPath = (node: ConditionNode, path: Segments): Segments | null => {
  if (!isRelationNode(node)) return null;
  return typeof node.field === 'string' ? consume(path, node.field) : path;
};

const matchesLeaf = (node: ConditionNode, path: Segments): boolean =>
  !isRelationNode(node) &&
  typeof node.field === 'string' &&
  consume(path, node.field)?.length === 0;

export type FieldValueRefs = {
  /** Every literal a matching leaf compares against, list operators flattened, first-seen order. */
  values: RuleValue[];
  /** Bind names on matching leaves — resolve with `resolveBindings` to turn them into literals. */
  binds: string[];
  /** `path` sources on matching leaves (`'$.col'` / context refs) — dynamic by nature. */
  paths: string[];
};

/**
 * The values a condition tree compares a given field against — the read half of the pair
 * (`transformFieldValues` is the write half), and the engine-owned answer to "which X does
 * this rule mention".
 *
 * `fieldPath` is dotted from the tree's root model (`'fanUserGroups.group.uuid'`), matching
 * both authoring spellings (nested relation `condition`s and dotted `field`s). Values are
 * collected regardless of operator and quantifier: a `none` relation mentions its value as
 * much as an `any` one, and `in` / `notIn` / `between` lists flatten. An aggregate node's
 * own comparison value belongs to the aggregate, not to the relation it names. Non-literal
 * sources are reported by name in `binds` / `paths`, never silently dropped — a gate that
 * must fail closed checks those, and can `resolveBindings` first to shrink `binds`.
 */
export const referencedFieldValues = (condition: Condition, fieldPath: string): FieldValueRefs => {
  const values = new Set<RuleValue>();
  const binds = new Set<string>();
  const paths = new Set<string>();

  visitCondition(condition, fieldPath.split('.') as Segments, {
    descend: descendByFieldPath,
    enter: (node, path) => {
      if (!matchesLeaf(node, path)) return;
      if (typeof node.bind === 'string') {
        binds.add(node.bind);
        return;
      }
      if (typeof node.path === 'string') {
        paths.add(node.path);
        return;
      }
      if (!('value' in node)) return;
      const value = node.value as RuleValue;
      for (const entry of Array.isArray(value) ? value : [value]) values.add(entry);
    },
  });

  return { values: [...values], binds: [...binds], paths: [...paths] };
};

/** String and number literals carry ids; anything else has no key and never remaps. */
const remapLiteral = (value: RuleValue, mapping: Record<string, RuleValue>): RuleValue => {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const key = String(value);
  return key in mapping ? mapping[key] : value;
};

/**
 * Rewrite the literals a given field is compared against through a lookup table, leaving
 * the tree's shape and every other leaf untouched. The remap primitive for callers that
 * clone or re-key the data a rule names (a sandbox clone re-pointing ids, a merge
 * re-pointing a renamed key). Plain data on both sides — the mapping serializes with the
 * rule it rewrites.
 *
 * Same `fieldPath` semantics as `referencedFieldValues`. `path` / `bind` leaves are left
 * alone — there is no literal to rewrite, and inventing one would silently change the
 * rule. Does not mutate the input.
 */
export const transformFieldValues = (
  condition: Condition,
  fieldPath: string,
  mapping: Record<string, RuleValue>,
): Condition =>
  mapCondition(condition, fieldPath.split('.') as Segments, {
    descend: descendByFieldPath,
    rewrite: (node, path) => {
      if (!matchesLeaf(node, path)) return node;
      if (!('value' in node) || node.path !== undefined || node.bind !== undefined) return node;
      const value = node.value as RuleValue;
      node.value = Array.isArray(value)
        ? value.map((entry) => remapLiteral(entry, mapping))
        : remapLiteral(value, mapping);
      return node;
    },
  });
