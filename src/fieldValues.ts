import { type ConditionNode, isRelationNode, mapCondition, visitCondition } from './traverse';
import type { Condition, RuleValue } from './types';

type Segments = readonly string[];

// A `field` consumes leading segments of the remaining fieldPath, or null when it names
// something else. Descent keeps the remainder; a leaf match is full consumption.
const consume = (path: Segments, field: string): Segments | null => {
  const parts = field.split('.');
  if (parts.length > path.length) return null;
  for (let i = 0; i < parts.length; i++) if (parts[i] !== path[i]) return null;
  return path.slice(parts.length);
};

// A fieldless relation (root array) is walked through — a missed reference is the
// dangerous direction for the gates that call this.
const descendByFieldPath = (node: ConditionNode, path: Segments): Segments | null => {
  if (!isRelationNode(node)) return null;
  return typeof node.field === 'string' ? consume(path, node.field) : path;
};

const matchesLeaf = (node: ConditionNode, path: Segments): boolean =>
  !isRelationNode(node) &&
  typeof node.field === 'string' &&
  consume(path, node.field)?.length === 0;

export type FieldValueRefs = {
  values: RuleValue[];
  binds: string[];
  paths: string[];
};

/**
 * The values a condition tree compares `fieldPath` against, both authoring spellings,
 * quantifier- and operator-blind. Non-literal sources are reported by name in
 * `binds` / `paths`, never dropped — resolveBindings first to shrink `binds`.
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

const remapLiteral = (value: RuleValue, mapping: Record<string, RuleValue>): RuleValue => {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const key = String(value);
  return key in mapping ? mapping[key] : value;
};

/**
 * Rewrite the literals compared at `fieldPath` through a lookup table, leaving the
 * tree's shape and every other leaf untouched. Non-mutating.
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
