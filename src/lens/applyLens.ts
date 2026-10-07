import { ArrayOperator } from '../operator.ts';
import { parseScopeRef, resolveScopeRef } from '../scope';
import { isLogicalNode, isRelationNode, mapCondition, valueRefs } from '../traverse';
import type { Condition, WindowFields } from '../types.ts';
import { hasWindow } from '../window.ts';
import type { Policy } from './policy.ts';
import { type RelationHop, relationHops, resolvePolicy, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

// Composes a user rule with the lens's narrowing where-clauses, injecting each
// `where` at its proper anchor in the rule tree (not blindly AND-ing at root).
//
// Anchoring rules (2.2.0):
//   - root.where → AND at root (path-specific at lens anchor)
//   - mapDefaults[M].models[X].where → injected wherever rule visits X in map M
//   - root.relations[R]...relations[R].where → injected when rule descends through R
//
// Operator-specific injection inside an arrayRule:
//   - any/none/atLeast/atMost/exactly/aggregate.condition: AND with original condition
//   - all and windowed rules: filter-first via the array rule's window `filter` (drops out-of-scope rows before
//     order/take/skip and before the all-check) — never a per-row negate implication

const wrapWithWheres = (rule: Condition, wheres: Condition[]): Condition => {
  if (wheres.length === 0) return rule;
  return { all: [...wheres, rule] };
};

// Re-roots a related-model `where` grant so its field refs resolve from the current
// anchor through the relation path (e.g. a User grant `tenantId` reached via `author`
// becomes `author.tenantId`). Fails closed on shapes that can't be re-rooted
// unambiguously — a `path` ref (root/current-element semantics don't survive re-rooting)
// or a nested array/aggregate condition (row-scoped to a different anchor) — rather than
// silently emitting a wrong or unenforced grant.
export const prefixConditionFields = (cond: Condition, prefix: string): Condition =>
  mapCondition(cond, {
    rewrite: (node) => {
      if (isLogicalNode(node)) return node;
      if (typeof node.field !== 'string' || node.field === '')
        throw new Error(
          `applyLens: cannot re-root a relation grant of unknown shape under '${prefix}'`,
        );
      const refs = valueRefs(node);
      if (refs.length) {
        throw new Error(
          `applyLens: cannot re-root a relation grant with a path reference ('${refs[0]}') ` +
            `under '${prefix}'. Author the grant without 'path', or anchor it at the relation itself.`,
        );
      }
      if (parseScopeRef(node.field)) {
        throw new Error(
          `applyLens: cannot re-root a relation grant with a scope ref field ('${node.field}') ` +
            `under '${prefix}'. Author the grant against the model's own columns.`,
        );
      }
      if (node.condition !== undefined) {
        throw new Error(
          `applyLens: cannot re-root a relation grant with a nested array/aggregate condition on ` +
            `'${node.field}' under '${prefix}'. Anchor such grants at the relation's own model.`,
        );
      }
      return { ...node, field: `${prefix}.${node.field}` };
    },
    // A relation node's `filter` is relative to its elements, not to the anchor.
    below: () => false,
  });

type Visit = { mapName: string; modelName: string; relPath: readonly string[] };

// Gathers the (re-rooted) wheres for each traversed relation hop so they can be AND-ed
// with the rule at the current anchor. To-many hops have no scalar path to AND against —
// their grant must be row-scoped via an arrayOperator condition — so reaching one here
// (a to-many with a grant but no condition anchor) fails closed rather than dropping it.
const collectHopWheres = (policy: Policy, hops: RelationHop[]): Condition[] => {
  const out: Condition[] = [];
  for (const hop of hops) {
    const effect = resolveVisit(policy, hop.map, hop.model, hop.relPath);
    if (effect.whereClauses.length === 0) continue;
    if (hop.isList) {
      throw new Error(
        `applyLens: cannot enforce a to-many relation grant on '${hop.prefix}' without an ` +
          `arrayOperator condition to anchor it (row-scoped). Traverse '${hop.prefix}' via an ` +
          `array operator (any/all/none/...) so the grant can be injected safely.`,
      );
    }
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, hop.prefix));
  }
  return out;
};

// Where a node's field leads: every relation hop it crosses (each may carry a grant), and the
// visit its `condition` / `filter` resolve at when its last segment is a relation. A `$`-prefixed
// field names an ancestor scope; its grants re-root under the same prefix. Out of bounds fails
// closed.
const anchorOf = (
  node: Record<string, unknown>,
  policy: Policy,
  scopes: readonly Visit[],
): { hops: RelationHop[]; below: Visit | null } | null => {
  if (isLogicalNode(node) || typeof node.field !== 'string' || node.field === '') return null;
  const target = resolveScopeRef(node.field, scopes);
  if ('outOfBounds' in target) throw new Error(`applyLens: ${target.outOfBounds}`);
  const scopePrefix = node.field.slice(0, node.field.length - target.path.length);
  const { hops, end } = relationHops(policy.lens.maps, target.scope, target.path, scopePrefix);
  return { hops, below: end };
};

const allOf = (conditions: Condition[]): Condition =>
  conditions.length === 1 ? conditions[0] : { all: conditions };

// Injects each grant at its anchor. A relation node (array or aggregate) whose field ends on a
// relation gets that relation's grants row-scoped: AND-ed into its `condition`, or — for `all`, a
// window, or a node with no `condition` (a count, an aggregate, emptiness) — into its `filter`,
// which drops out-of-scope rows before anything else reads them. Every other hop's grant is
// re-rooted under the hop and AND-ed with the node.
const rewriteRule = (rule: Condition, policy: Policy, root: Visit): Condition =>
  mapCondition<readonly Visit[]>(
    rule,
    {
      below: (node, scopes) => {
        const below = anchorOf(node, policy, scopes)?.below;
        return below ? [...scopes, below] : false;
      },
      after: (node, scopes) => {
        const anchor = anchorOf(node, policy, scopes);
        if (!anchor) return node as Condition;
        const scoped = anchor.below !== null && isRelationNode(node);
        if (!scoped)
          return wrapWithWheres(node as Condition, collectHopWheres(policy, anchor.hops));
        const below = anchor.below as Visit;
        const grants = resolveVisit(
          policy,
          below.mapName,
          below.modelName,
          below.relPath,
        ).whereClauses;
        const filterFirst =
          node.condition === undefined ||
          node.arrayOperator === ArrayOperator.all ||
          hasWindow(node as WindowFields);
        const out: Record<string, unknown> = { ...node };
        if (grants.length && filterFirst)
          out.filter = allOf([
            ...(node.filter !== undefined ? [node.filter as Condition] : []),
            ...grants,
          ]);
        else if (grants.length) out.condition = allOf([...grants, node.condition as Condition]);
        return wrapWithWheres(out as Condition, collectHopWheres(policy, anchor.hops.slice(0, -1)));
      },
    },
    [root],
  );

export const applyLens = (rule: Condition, lensOrNarrowing: Lens | LensNarrowing): Condition => {
  const policy = resolvePolicy(lensOrNarrowing);
  const rootEffect = resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);

  // First rewrite the rule, injecting where clauses at their anchors.
  const rewritten = rewriteRule(rule, policy, {
    mapName: policy.lens.mapName,
    modelName: policy.lens.model,
    relPath: [],
  });

  // Then wrap with root-anchored where clauses (root.where +
  // mapDefaults[lens.mapName].models[lens.model].where).
  return wrapWithWheres(rewritten, rootEffect.whereClauses);
};
