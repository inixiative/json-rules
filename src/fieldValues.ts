import { type ConditionNode, isRelationNode, mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

/** `path` with `prefix`'s segments removed, or null when `prefix` isn't a segment prefix. */
const stripPrefix = (path: string, prefix: string): string | null => {
  if (path === prefix) return '';
  return path.startsWith(`${prefix}.`) ? path.slice(prefix.length + 1) : null;
};

/**
 * Relation descent consumes the segments the relation's `field` names; a relation with no
 * `field` (a root array) consumes none and is walked THROUGH — the callers are gates, and
 * a missed reference is the dangerous direction. Non-relation nodes never scope children
 * to a row, so their `condition` / `filter` are pruned for field-path purposes.
 */
const descendByFieldPath = (node: ConditionNode, fieldPath: string): string | null => {
  if (!isRelationNode(node)) return null;
  const field = typeof node.field === 'string' ? node.field : undefined;
  return field === undefined ? fieldPath : stripPrefix(fieldPath, field);
};

const matchesLeaf = (node: ConditionNode, fieldPath: string): boolean =>
  !isRelationNode(node) && typeof node.field === 'string' && node.field === fieldPath;

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

  visitCondition(condition, fieldPath, {
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
  mapCondition(condition, fieldPath, {
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
