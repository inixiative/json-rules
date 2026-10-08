import { check } from '../check';
import { ArrayOperator } from '../operator.ts';
import { parseScopeRef, readScopeRef } from '../scope';
import {
  allOf,
  anyOf,
  elementRefs,
  isLogicalNode,
  isRelationNode,
  mapCondition,
  valueRefs,
} from '../traverse';
import type { Condition, WindowFields } from '../types.ts';
import { hasWindow } from '../window.ts';
import type { Policy } from './policy.ts';
import {
  LensRefusal,
  type RelationHop,
  relationHops,
  resolvePolicy,
  resolveVisit,
} from './policy.ts';
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

// Whether a node holds with its field absent — check() answers. A node reading a value ref (or
// one check() can't settle without options) keeps the plain AND, which only narrows.
const holdsWhenAbsent = (node: Condition): boolean => {
  if (valueRefs(node as Record<string, unknown>).length) return false;
  // A `$`-scoped field reads the same way at its own scope.
  const field = (node as { field?: unknown }).field;
  const scoped = typeof field === 'string' ? parseScopeRef(field) : null;
  try {
    return (
      check(scoped ? ({ ...(node as object), field: scoped.path } as Condition) : node, {}) === true
    );
  } catch {
    return false;
  }
};

// A node read through granted hops: each hop's grant AND-ed with it, so a related row outside its
// grant fails the node. A missing related row is not a hidden one — where the node holds with its
// path absent (a negation, notExists), a hop that isn't there satisfies it without the grant.
const underHopGrants = (node: Condition, hops: HopGrant[]): Condition => {
  if (!hops.length) return node;
  if (!holdsWhenAbsent(node)) return allOf([...hops.flatMap((hop) => hop.grants), node]);
  const [hop, ...deeper] = hops;
  return anyOf([
    allOf([...hop.grants, underHopGrants(node, deeper)]),
    allOf([{ field: hop.prefix, operator: 'notExists' } as Condition, node]),
  ]);
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
        throw new LensRefusal(
          `narrowRule: cannot re-root a relation grant of unknown shape under '${prefix}'`,
          'unsupported_grant',
        );
      const refs = valueRefs(node);
      if (refs.length) {
        throw new LensRefusal(
          `narrowRule: cannot re-root a relation grant with a path reference ('${refs[0]}') ` +
            `under '${prefix}'. Author the grant without 'path', or anchor it at the relation itself.`,
          'unsupported_grant',
        );
      }
      if (parseScopeRef(node.field)) {
        throw new LensRefusal(
          `narrowRule: cannot re-root a relation grant with a scope ref field ('${node.field}') ` +
            `under '${prefix}'. Author the grant against the model's own columns.`,
          'unsupported_grant',
        );
      }
      if (node.condition !== undefined) {
        throw new LensRefusal(
          `narrowRule: cannot re-root a relation grant with a nested array/aggregate condition on ` +
            `'${node.field}' under '${prefix}'. Anchor such grants at the relation's own model.`,
          'unsupported_grant',
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
type HopGrant = { prefix: string; grants: Condition[] };

const hopGrants = (policy: Policy, hops: RelationHop[]): HopGrant[] =>
  hops.flatMap((hop) => {
    const effect = resolveVisit(policy, hop.map, hop.model, hop.relPath);
    if (effect.whereClauses.length === 0) return [];
    if (hop.isList) {
      throw new Error(
        `narrowRule: cannot enforce a to-many relation grant on '${hop.prefix}' without an ` +
          `arrayOperator condition to anchor it (row-scoped). Traverse '${hop.prefix}' via an ` +
          `array operator (any/all/none/...) so the grant can be injected safely.`,
      );
    }
    return [
      {
        prefix: hop.prefix,
        grants: effect.whereClauses.map((where) => prefixConditionFields(where, hop.prefix)),
      },
    ];
  });

const collectHopWheres = (policy: Policy, hops: RelationHop[]): Condition[] =>
  hopGrants(policy, hops).flatMap((hop) => hop.grants);

// A scope is a visit the walk reached, or null inside a Json value (undeclared: nothing to grant).
type Scope = Visit | null;

// The relation hops a ref crosses from the scope it names, and the visit it ends on. Grants
// re-root under the ref's own scope prefix (`$.` is the node's own scope, so none).
const hopsAt = (
  ref: string,
  policy: Policy,
  scopes: readonly Scope[],
): { hops: RelationHop[]; end: Visit | null } => {
  const target = readScopeRef(ref, scopes);
  if ('outOfBounds' in target) throw new Error(`narrowRule: ${target.outOfBounds}`);
  if (!target.scope) return { hops: [], end: null };
  const prefix = ref.slice(0, ref.length - target.path.length);
  return relationHops(policy.lens.maps, target.scope, target.path, prefix === '$.' ? '' : prefix);
};

// A value ref's hops. A bare one reads the root row on every rail, so its grants re-root at the
// root.
const refHops = (ref: string, policy: Policy, scopes: readonly Scope[]): RelationHop[] => {
  if (parseScopeRef(ref)) return hopsAt(ref, policy, scopes).hops;
  const prefix = scopes.length === 1 ? '' : `${'$'.repeat(scopes.length)}.`;
  return scopes[0] ? relationHops(policy.lens.maps, scopes[0], ref, prefix).hops : [];
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
  const { hops, end } = hopsAt(node.field, policy, scopes);
  return { hops, below: end };
};

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
          return wrapWithWheres(
            underHopGrants(node as Condition, hopGrants(policy, anchor.hops)),
            valueWheres,
          );
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
        return wrapWithWheres(
          underHopGrants(out as Condition, hopGrants(policy, anchor.hops.slice(0, -1))),
          valueWheres,
        );
      },
    },
    [root],
  );

/** A rule with the lens's grants (`where`s) injected at their anchors: the root's around it, each
 *  relation's where the rule descends into it — under an `all`, into its window `filter`. */
export const narrowRule = (rule: Condition, lensOrNarrowing: Lens | LensNarrowing): Condition => {
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
