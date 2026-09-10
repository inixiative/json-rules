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
import { resolvePolicy, walkLensPath } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * The values one rule compares at one declared source — keyed the way `projectByPath`
 * keys a source (`path` + `field`), so the caller can join it back to the source's
 * model without spelling a path of its own. A `mapDefaults`-declared source resolves
 * wherever its model appears, so `path` may name a relation chain the narrowing never
 * spelled under `root.relations`; the dotted format is the same.
 */
export type RuleSourceValues = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  /** Every literal a leaf at this source named; list operators flattened, deduped by content. */
  values: RuleValue[];
  /**
   * The set of values cannot be enumerated from literals: a leaf took its value from
   * `path` / `bind`, used an operator that describes values without naming them
   * (substring, pattern, range, date window), or used an operator the catalog does not
   * know. A caller deciding anything from `values` must fail closed.
   */
  dynamic: boolean;
};

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

/**
 * Which values a rule names at each source the lens declares — the lens owns the
 * vocabulary, so it answers questions about it; callers never spell a path. A leaf reaches a
 * source by its absolute path through the lens: nested (`{ field: 'orders', arrayOperator,
 * condition: { field: 'sku' } }`) and dotted (`{ field: 'orders.sku' }`) spellings are one path,
 * resolved by `walkLensPath` — visibility, `mapDefaults`, and the Json boundary all apply, so a
 * source declared in `mapDefaults` answers wherever its model appears. Quantifier-blind on
 * purpose — a `none` relation names its value as much as an `any` one, `notIn` as much as `in` —
 * but shape-aware via the operator catalog: only literal-naming shapes contribute `values`;
 * substring / pattern / range / window operators, and operators the catalog does not know, mark
 * the source `dynamic` instead of inventing values. A relation node's own comparison (an
 * aggregate's threshold, an array `count`) belongs to the node, not to a source. Paths invisible
 * under the lens, unmapped segments, and sub-paths beneath a Json column are silent.
 */
export const ruleSourceValues = (
  lensOrNarrowing: Lens | LensNarrowing,
  rule: Condition,
): RuleSourceValues[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  const root = policy.lens.model;
  const out = new Map<string, RuleSourceValues>();

  const record = (segments: string[], node: ConditionNode): void => {
    if (segments.length === 0) return;
    const resolved = walkLensPath(policy, policy.lens.mapName, root, [], segments.join('.'));
    if (!resolved || resolved.jsonSubPath.length > 0) return;
    const { mapName, modelName, relPath, terminalEffect, terminalFieldName } = resolved;
    if (!terminalEffect.sources.has(terminalFieldName)) return;

    const path = [root, ...relPath].join('.');
    const key = `${path}|${terminalFieldName}`;
    let entry = out.get(key);
    if (!entry) {
      entry = {
        path,
        mapName,
        model: modelName,
        field: terminalFieldName,
        values: [],
        dynamic: false,
      };
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
