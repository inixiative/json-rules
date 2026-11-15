import { leafCatalogEntry, ValueShape } from '../operatorCatalog';
import {
  type ConditionNode,
  isLogicalNode,
  isRelationNode,
  leafSources,
  visitCondition,
} from '../traverse.ts';
import type { Condition, RuleValue } from '../types.ts';
import { ruleLiterals } from './fieldFit.ts';
import {
  type LensWalk,
  lensRootScope,
  resolvePolicy,
  stepIntoField,
  type VisitScope,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * The values one rule compares at one declared source — keyed the way `projectPaths`
 * keys a source (`path` + `field`), so the caller can join it back to the source's
 * model without spelling a path of its own. A `mapDefaults`-declared source resolves
 * wherever its model appears on the declared relations; the dotted format is the same.
 */
export type RuleSourceDescription = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  /** Every literal a leaf at this source named; list operators flattened, deduped by content. */
  values: RuleValue[];
  /**
   * The set of values cannot be enumerated from literals: a leaf read a value at evaluation
   * (a `path` / `bind` on its comparison value, an offset or an amount) or moved it by an offset, used an operator that describes values without naming them
   * (substring, pattern, range, date window), or used an operator the catalog does not
   * know. A caller deciding anything from `values` must fail closed.
   */
  dynamic: boolean;
};

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

type Contribution = { values: RuleValue[]; dynamic: boolean };

const contribution = (node: ConditionNode): Contribution => {
  // A value read at evaluation — a path or bind anywhere on the leaf, its comparison value, an
  // offset or an amount — or an offset moving a literal: the literal doesn't name the value.
  if (
    node.offset !== undefined ||
    leafSources(node).some(({ source }) => source.value === undefined)
  )
    return { values: [], dynamic: true };
  const entry = leafCatalogEntry(node);
  if (!entry) return { values: [], dynamic: true };
  if (VALUELESS_SHAPES.has(entry.valueShape)) return { values: [], dynamic: false };
  if (!ENUMERABLE_SHAPES.has(entry.valueShape)) return { values: [], dynamic: true };
  if (!('value' in node)) return { values: [], dynamic: false };
  return { values: (ruleLiterals(node) ?? []) as RuleValue[], dynamic: false };
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
 * source walked as the gate walks it (`stepIntoField`, scope by scope): `{ field: 'orders',
 * arrayOperator, condition: { field: 'sku' } }` reaches `orders.sku`, and a plain path the gate
 * refuses (one continuing past a to-many relation, `{ field: 'orders.sku' }`) is silent. Declared
 * relations, visibility, `mapDefaults`, and the Json boundary all apply, so a source declared in `mapDefaults` answers wherever a declared path reaches its model. Quantifier-blind on
 * purpose — a `none` relation names its value as much as an `any` one, `notIn` as much as `in` —
 * but shape-aware via the operator catalog: only literal-naming shapes contribute `values`;
 * substring / pattern / range / window operators, and operators the catalog does not know, mark
 * the source `dynamic` instead of inventing values. A relation node's own comparison (an
 * aggregate's threshold, an array `count`) belongs to the node, not to a source. Paths invisible
 * or undeclared under the lens, unmapped segments, and sub-paths beneath a Json column are silent.
 */
export const describeRuleSources = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): RuleSourceDescription[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  const root = policy.lens.model;
  const out = new Map<string, RuleSourceDescription>();
  // Each entry's literal keys, so a large `in` list dedupes in linear time.
  const seenKeys = new Map<string, Set<string>>();

  const record = (walked: LensWalk, node: ConditionNode): void => {
    if (walked.jsonSubPath.length > 0) return;
    const { mapName, modelName, relPath, terminalEffect, terminalFieldName } = walked;
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
    const seen = seenKeys.get(key) ?? new Set<string>();
    seenKeys.set(key, seen);
    for (const literal of found.values) {
      const literalKey = dedupeKey(literal);
      if (seen.has(literalKey)) continue;
      seen.add(literalKey);
      entry.values.push(literal);
    }
  };

  visitCondition<readonly VisitScope[]>(
    rule,
    (node, scopes) => {
      if (isLogicalNode(node)) return;
      if (typeof node.field !== 'string' || node.field === '') return;
      const step = stepIntoField(policy, scopes, node.field);
      if ('issue' in step) return false;
      if (!isRelationNode(node) && step.walked) record(step.walked, node);
      return [...scopes, step.next];
    },
    [lensRootScope(policy)],
  );
  return [...out.values()];
};
