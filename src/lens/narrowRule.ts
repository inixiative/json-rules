import { ArrayOperator } from '../operator.ts';
import { parseScopeRef, readScopeRef } from '../scope';
import {
  assertConditionDepth,
  isLogicalNode,
  isRelationNode,
  mapCondition,
  valueRefs,
} from '../traverse';
import type { Condition, WindowFields } from '../types.ts';
import { hasWindow } from '../window.ts';
import type { Policy } from './policy.ts';
import { allOf, type RelationHop, relationHops, resolvePolicy, resolveVisit } from './policy.ts';
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

const wrapWithWheres = (rule: Condition, wheres: Condition[]): Condition =>
  wheres.length ? allOf([...wheres, rule]) : rule;

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
          `narrowRule: cannot re-root a relation grant of unknown shape under '${prefix}'`,
        );
      const refs = valueRefs(node);
      if (refs.length) {
        throw new Error(
          `narrowRule: cannot re-root a relation grant with a path reference ('${refs[0]}') ` +
            `under '${prefix}'. Author the grant without 'path', or anchor it at the relation itself.`,
        );
      }
      if (parseScopeRef(node.field)) {
        throw new Error(
          `narrowRule: cannot re-root a relation grant with a scope ref field ('${node.field}') ` +
            `under '${prefix}'. Author the grant against the model's own columns.`,
        );
      }
      if (node.condition !== undefined) {
        throw new Error(
          `narrowRule: cannot re-root a relation grant with a nested array/aggregate condition on ` +
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
        `narrowRule: cannot enforce a to-many relation grant on '${hop.prefix}' without an ` +
          `arrayOperator condition to anchor it (row-scoped). Traverse '${hop.prefix}' via an ` +
          `array operator (any/all/none/...) so the grant can be injected safely.`,
      );
    }
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, hop.prefix));
  }
  return out;
};

// A scope is a visit the walk reached, or null inside a Json value (undeclared: nothing to grant).
type Scope = Visit | null;

// The relation hops a ref crosses and the prefix its grants re-root under. A `$`-prefixed ref
// names an ancestor scope (`$.` is the node's own, so its grants need no prefix). A bare ref is a
// root-row path — the lens gate resolves it at the lens model, and check() reads it from the row
// when no context is given — so its grants re-root at the root.
const refHops = (ref: string, policy: Policy, scopes: readonly Scope[]): RelationHop[] => {
  if (!parseScopeRef(ref)) {
    const prefix = scopes.length === 1 ? '' : `${'$'.repeat(scopes.length)}.`;
    return scopes[0] ? relationHops(policy.lens.maps, scopes[0], ref, prefix).hops : [];
  }
  const target = readScopeRef(ref, scopes);
  if ('outOfBounds' in target) throw new Error(`narrowRule: ${target.outOfBounds}`);
  if (!target.scope) return [];
  const prefix = ref.slice(0, ref.length - target.path.length);
  return relationHops(policy.lens.maps, target.scope, target.path, prefix === '$.' ? '' : prefix)
    .hops;
};

// Where a node's field leads: every relation hop it crosses (each may carry a grant), and the
// scope its `condition` / `filter` read at — the relation's visit when its last segment is one,
// an open scope for a relation node over a Json array.
const anchorOf = (
  node: Record<string, unknown>,
  policy: Policy,
  scopes: readonly Scope[],
): { hops: RelationHop[]; below: Visit | null } | null => {
  if (isLogicalNode(node) || typeof node.field !== 'string' || node.field === '') return null;
  const target = readScopeRef(node.field, scopes);
  if ('outOfBounds' in target) throw new Error(`narrowRule: ${target.outOfBounds}`);
  if (!target.scope) return { hops: [], below: null };
  const scopePrefix = node.field.slice(0, node.field.length - target.path.length);
  const { hops, end } = relationHops(policy.lens.maps, target.scope, target.path, scopePrefix);
  return { hops, below: end };
};

// The element fields a relation node orders or aggregates by — read per element, under the
// element's grants.
const elementRefs = (node: Record<string, unknown>): string[] => [
  ...(Array.isArray(node.orderBy)
    ? (node.orderBy as { field?: unknown }[]).flatMap((o) =>
        typeof o?.field === 'string' ? [o.field] : [],
      )
    : []),
  ...(typeof (node.aggregate as { field?: unknown })?.field === 'string'
    ? [(node.aggregate as { field: string }).field]
    : []),
];

// Injects each grant at its anchor. A relation node (array or aggregate) whose field ends on a
// relation gets that relation's grants row-scoped: AND-ed into its `condition`, or — for `all`, a
// window, or a node with no `condition` (a count, an aggregate, emptiness) — into its `filter`,
// which drops out-of-scope rows before anything else reads them; relations its `orderBy` or
// `aggregate.field` cross add their grants there too. Every other hop's grant — on the field, or
// on a value-side ref (`path`, an offset, an amount) — is re-rooted under the hop and AND-ed with
// the node.
/** A rule's grants injected at their anchors, the rule read from `root` under `policy`. */
export const narrowAt = (rule: Condition, policy: Policy, root: Visit): Condition =>
  mapCondition<readonly Scope[]>(
    rule,
    {
      below: (node, scopes) => {
        const anchor = anchorOf(node, policy, scopes);
        if (!anchor) return false;
        if (anchor.below) return [...scopes, anchor.below];
        return isRelationNode(node) ? [...scopes, null] : false;
      },
      after: (node, scopes) => {
        const anchor = anchorOf(node, policy, scopes);
        if (!anchor) return node as Condition;
        const valueWheres = collectHopWheres(
          policy,
          valueRefs(node).flatMap((ref) => refHops(ref, policy, scopes)),
        );
        const below = anchor.below;
        if (!below || !isRelationNode(node))
          return wrapWithWheres(node as Condition, [
            ...collectHopWheres(policy, anchor.hops),
            ...valueWheres,
          ]);
        const grants = [
          ...resolveVisit(policy, below.mapName, below.modelName, below.relPath).whereClauses,
          ...collectHopWheres(
            policy,
            elementRefs(node).flatMap((ref) => relationHops(policy.lens.maps, below, ref).hops),
          ),
        ];
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
        return wrapWithWheres(out as Condition, [
          ...collectHopWheres(policy, anchor.hops.slice(0, -1)),
          ...valueWheres,
        ]);
      },
    },
    [root],
  );

export const narrowRule = (rule: Condition, lensOrNarrowing: Lens | LensNarrowing): Condition => {
  assertConditionDepth(rule);
  const policy = resolvePolicy(lensOrNarrowing);
  const rootEffect = resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);

  // First rewrite the rule, injecting where clauses at their anchors.
  const rewritten = narrowAt(rule, policy, {
    mapName: policy.lens.mapName,
    modelName: policy.lens.model,
    relPath: [],
  });

  // Then wrap with root-anchored where clauses (root.where +
  // mapDefaults[lens.mapName].models[lens.model].where).
  return wrapWithWheres(rewritten, rootEffect.whereClauses);
};
