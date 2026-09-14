import {
  type CatalogEntry,
  DATE_OPERATOR_CATALOG,
  FIELD_OPERATOR_CATALOG,
  ValueShape,
} from '../operatorCatalog';
import { own } from '../own';
import { resolveScopeRef } from '../scope';
import { type ConditionNode, isRelationNode, visitCondition } from '../traverse.ts';
import type { Condition, RuleValue } from '../types.ts';
import { type Policy, walkLensPath } from './policy.ts';

const DYNAMIC_KEYS = ['path', 'bind'] as const;

/** Shapes whose `value` IS the named value(s): a literal, an ordered literal, a list, a
 * day list, or a date literal / point expression. Everything else describes values
 * without enumerating them. */
const ENUMERABLE_SHAPES = new Set<string>([
  ValueShape.scalar,
  ValueShape.ordered,
  ValueShape.array,
  ValueShape.dayList,
  ValueShape.dateValue,
]);

/** Shapes whose `value` is not about the field's values at all (a flag, a cardinality). */
const VALUELESS_SHAPES = new Set<string>([ValueShape.none, ValueShape.count]);

const catalogEntry = (node: ConditionNode): CatalogEntry | undefined => {
  if (typeof node.operator === 'string') return own(FIELD_OPERATOR_CATALOG, node.operator);
  if (typeof node.dateOperator === 'string') return own(DATE_OPERATOR_CATALOG, node.dateOperator);
  return undefined;
};

const literals = (value: unknown): RuleValue[] =>
  Array.isArray(value) ? value.flatMap(literals) : [value as RuleValue];

type Contribution = { values: RuleValue[]; dynamic: boolean };

const contribution = (node: ConditionNode): Contribution => {
  if (DYNAMIC_KEYS.some((k) => own(node as Record<string, unknown>, k) !== undefined)) {
    return { values: [], dynamic: true };
  }
  const entry = catalogEntry(node);
  if (!entry) return { values: [], dynamic: true };
  if (VALUELESS_SHAPES.has(entry.valueShape)) return { values: [], dynamic: false };
  if (!ENUMERABLE_SHAPES.has(entry.valueShape)) return { values: [], dynamic: true };
  if (!('value' in node)) return { values: [], dynamic: false };
  return { values: literals(node.value), dynamic: false };
};

const dedupeKey = (value: RuleValue): string => {
  if (value instanceof Date) return `d:${+value}`;
  if (value instanceof RegExp) return `r:${value}`;
  if (typeof value === 'object' && value !== null) return `j:${JSON.stringify(value)}`;
  return `p:${typeof value}:${String(value)}`;
};

/** What a resolved leaf is, before the caller decides whether to keep it. */
export type ResolvedLeaf = {
  path: string;
  mapName: string;
  model: string;
  field: string;
};

/** The accumulator every consumer shares: the literals a leaf named, plus whether the
 *  set can be enumerated at all. */
export type LeafValues = ResolvedLeaf & {
  values: RuleValue[];
  dynamic: boolean;
};

/**
 * The one walk. Every leaf of `rule` is resolved to its absolute path through the lens —
 * nested and dotted spellings collapse to the same path, scope refs anchor at the scope they
 * name, and paths invisible under the lens or beneath a Json boundary are silent. `keep`
 * decides which resolved leaves this consumer cares about and returns the extra keying it
 * wants merged into the entry; returning `undefined` drops the leaf.
 *
 * Quantifier-blind on purpose — a `none` relation names its value as much as an `any` one,
 * `notIn` as much as `in` — but shape-aware via the operator catalog: only literal-naming
 * shapes contribute `values`; substring / pattern / range / window operators, and operators
 * the catalog does not know, mark the leaf `dynamic` instead of inventing values.
 */
export const ruleLeafValues = <Extra extends Record<string, unknown>>(
  policy: Policy,
  rule: Condition,
  keep: (leaf: ResolvedLeaf, terminal: ReturnType<typeof walkLensPath>) => Extra | undefined,
): (LeafValues & Extra)[] => {
  const root = policy.lens.model;
  const out = new Map<string, LeafValues & Extra>();

  const record = (segments: string[], node: ConditionNode): void => {
    if (segments.length === 0) return;
    const resolved = walkLensPath(policy, policy.lens.mapName, root, [], segments.join('.'));
    if (!resolved || resolved.jsonSubPath.length > 0) return;
    const { mapName, modelName, relPath, terminalFieldName } = resolved;

    const path = [root, ...relPath].join('.');
    const leaf: ResolvedLeaf = { path, mapName, model: modelName, field: terminalFieldName };
    const extra = keep(leaf, resolved);
    if (!extra) return;

    const key = `${path}|${terminalFieldName}`;
    let entry = out.get(key);
    if (!entry) {
      entry = { ...leaf, values: [], dynamic: false, ...extra } as LeafValues & Extra;
      out.set(key, entry);
    }
    const found = contribution(node);
    if (found.dynamic) entry.dynamic = true;
    for (const literal of found.values) {
      if (!entry.values.some((seen) => dedupeKey(seen) === dedupeKey(literal))) {
        entry.values.push(literal);
      }
    }
  };

  // `prefixes` is the stack of absolute anchors, innermost last; a `$`-prefixed field
  // anchors at the scope it names. An out-of-bounds ref anchors nowhere and is silent.
  const walk = (condition: Condition, prefixes: readonly string[][]): void => {
    const anchorOf = (field: string): string[] | undefined => {
      const target = resolveScopeRef(field, prefixes);
      if ('outOfBounds' in target) return undefined;
      return [...target.scope, ...target.path.split('.')];
    };
    visitCondition(condition, {
      enter: (node) => {
        if (isRelationNode(node)) return;
        if (typeof node.field !== 'string') return;
        const anchor = anchorOf(node.field);
        if (anchor) record(anchor, node);
      },
      descend: (node) => {
        const anchor =
          typeof node.field === 'string' ? anchorOf(node.field) : prefixes[prefixes.length - 1];
        if (!anchor) return false;
        const below = [...prefixes, anchor];
        if (node.condition !== undefined) walk(node.condition as Condition, below);
        if (node.filter !== undefined) walk(node.filter as Condition, below);
        return false;
      },
    });
  };

  walk(rule, [[]]);
  return [...out.values()];
};
