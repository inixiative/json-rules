import { ArrayOperator } from '../operator.ts';
import type { Condition } from '../types.ts';
import { negate } from './negate.ts';
import type { Policy } from './policy.ts';
import { resolvePolicy, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

// Composes a user rule with the lens's narrowing where-clauses, injecting each
// `where` at its proper anchor in the rule tree (not blindly AND-ing at root).
//
// Anchoring rules (2.2.0):
//   - root.where → AND at root (path-specific at lens anchor)
//   - mapDefaults[M].models[X].where → injected wherever rule visits X in map M
//   - root.relations[R]...relations[R].where → injected when rule descends through R
//
// Operator-specific injection inside an arrayRule.condition:
//   - any/none/atLeast/atMost/exactly/aggregate.condition: AND with original
//   - all: filter-first via `{ any: [negate(where), original] }`

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
const prefixConditionFields = (cond: Condition, prefix: string): Condition => {
  if (typeof cond === 'boolean') return cond;
  if ('all' in cond) return { ...cond, all: cond.all.map((c) => prefixConditionFields(c, prefix)) };
  if ('any' in cond) return { ...cond, any: cond.any.map((c) => prefixConditionFields(c, prefix)) };
  if ('if' in cond) {
    return {
      ...cond,
      if: prefixConditionFields(cond.if, prefix),
      then: prefixConditionFields(cond.then, prefix),
      else: cond.else !== undefined ? prefixConditionFields(cond.else, prefix) : cond.else,
    };
  }
  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    if ('path' in cond && cond.path !== undefined) {
      throw new Error(
        `applyLens: cannot re-root a relation grant with a path reference ('${String(cond.path)}') ` +
          `under '${prefix}'. Author the grant without 'path', or anchor it at the relation itself.`,
      );
    }
    if ('condition' in cond && cond.condition !== undefined) {
      throw new Error(
        `applyLens: cannot re-root a relation grant with a nested array/aggregate condition on ` +
          `'${cond.field}' under '${prefix}'. Anchor such grants at the relation's own model.`,
      );
    }
    return { ...cond, field: `${prefix}.${cond.field}` };
  }
  throw new Error(`applyLens: cannot re-root a relation grant of unknown shape under '${prefix}'`);
};

type RelationHop = {
  map: string;
  model: string;
  relPath: string[];
  prefix: string;
  isList: boolean;
};

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

// Inject `where` into an arrayRule's inner condition with the correct semantic.
const injectIntoArrayCondition = (
  innerCondition: Condition,
  whereClause: Condition,
  arrayOperator: ArrayOperator,
): Condition => {
  if (arrayOperator === ArrayOperator.all) {
    // Filter-first: every row that satisfies `where` must also satisfy user condition.
    // Equivalent: every row satisfies (NOT where OR user condition).
    return { any: [negate(whereClause), innerCondition] };
  }
  // any / none / atLeast / atMost / exactly: AND injection is correct
  return { all: [whereClause, innerCondition] };
};

// Walks the user rule recursively, looking for points where a model anchor
// matches a `where` declared in the policy. At each such anchor, injects the
// `where` with the appropriate semantic for the surrounding rule shape.
const rewriteRule = (
  rule: Condition,
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): Condition => {
  if (typeof rule === 'boolean') return rule;

  if ('all' in rule) {
    return {
      ...rule,
      all: rule.all.map((c) => rewriteRule(c, policy, mapName, modelName, relPath)),
    };
  }
  if ('any' in rule) {
    return {
      ...rule,
      any: rule.any.map((c) => rewriteRule(c, policy, mapName, modelName, relPath)),
    };
  }
  if ('if' in rule) {
    return {
      ...rule,
      if: rewriteRule(rule.if, policy, mapName, modelName, relPath),
      then: rewriteRule(rule.then, policy, mapName, modelName, relPath),
      else:
        rule.else !== undefined
          ? rewriteRule(rule.else, policy, mapName, modelName, relPath)
          : rule.else,
    };
  }

  // arrayRule, aggregate, dateRule, plain Rule — all have a `field`.
  if ('field' in rule && typeof rule.field === 'string' && rule.field !== '') {
    const fieldMap = policy.lens.maps[mapName];
    const model = fieldMap?.models[modelName];
    if (!model) return rule;
    const parts = rule.field.split('.');
    // Walk the field path, recording EVERY relation hop it traverses (including mid-path
    // to-one hops), so each hop's model-anchored `where` grant can be enforced — not only
    // when the FINAL segment is a relation.
    let curMap = mapName;
    let curModel = modelName;
    let curRelPath: string[] = [...relPath];
    let descended = false;
    const relationHops: RelationHop[] = [];
    for (let i = 0; i < parts.length; i++) {
      const m = policy.lens.maps[curMap]?.models[curModel];
      if (!m) break;
      const entry = m.fields[parts[i]];
      if (!entry) break;
      const isFinal = i === parts.length - 1;
      if (entry.kind !== 'object' && entry.kind !== 'bridge') break; // scalar/Json — stop descent
      const target = resolveRelationTarget(entry, curMap);
      if (!target) break;
      curRelPath = [...curRelPath, parts[i]];
      curMap = target.mapName;
      curModel = target.modelName;
      relationHops.push({
        map: curMap,
        model: curModel,
        relPath: [...curRelPath],
        prefix: parts.slice(0, i + 1).join('.'),
        isList: entry.isList === true,
      });
      if (isFinal) descended = true;
    }

    // Final relation with an inner condition (arrayRule / aggregate): recurse into the
    // condition at the descended model context and inject that relation's wheres with the
    // row-scoped semantic. Mid-path hops before it are enforced via re-rooting.
    if ('condition' in rule && rule.condition !== undefined && descended) {
      const effectAtDescent = resolveVisit(policy, curMap, curModel, curRelPath);
      let inner = rewriteRule(rule.condition, policy, curMap, curModel, curRelPath);
      const arrayOp = 'arrayOperator' in rule ? (rule.arrayOperator as ArrayOperator) : undefined;
      for (const whereClause of effectAtDescent.whereClauses) {
        if (arrayOp) {
          inner = injectIntoArrayCondition(inner, whereClause, arrayOp);
        } else {
          // aggregate condition: AND injection
          inner = { all: [whereClause, inner] };
        }
      }
      const rewritten = { ...rule, condition: inner } as Condition;
      return wrapWithWheres(rewritten, collectHopWheres(policy, relationHops.slice(0, -1)));
    }

    // No inner-condition injection: enforce every traversed relation's `where` by
    // re-rooting it under the relation path and AND-ing it with the rule (to-one and
    // mid-path hops). collectHopWheres fails closed on a to-many hop with a grant.
    return wrapWithWheres(rule, collectHopWheres(policy, relationHops));
  }

  return rule;
};

export const applyLens = (rule: Condition, lensOrNarrowing: Lens | LensNarrowing): Condition => {
  const policy = resolvePolicy(lensOrNarrowing);
  const rootEffect = resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);

  // First rewrite the rule, injecting where clauses at their anchors.
  const rewritten = rewriteRule(rule, policy, policy.lens.mapName, policy.lens.model, []);

  // Then wrap with root-anchored where clauses (root.where +
  // mapDefaults[lens.mapName].models[lens.model].where).
  return wrapWithWheres(rewritten, rootEffect.whereClauses);
};
