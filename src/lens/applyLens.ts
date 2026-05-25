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
    // Walk the field path to discover the relation target (if any) for descent.
    let curMap = mapName;
    let curModel = modelName;
    let curRelPath: string[] = [...relPath];
    let isRelation = false;
    let descended = false;
    for (let i = 0; i < parts.length; i++) {
      const m = policy.lens.maps[curMap]?.models[curModel];
      if (!m) break;
      const entry = m.fields[parts[i]];
      if (!entry) break;
      if (i === parts.length - 1) {
        if (entry.kind === 'object' || entry.kind === 'bridge') {
          isRelation = true;
          const target = resolveRelationTarget(entry, curMap);
          if (target) {
            curRelPath = [...curRelPath, parts[i]];
            curMap = target.mapName;
            curModel = target.modelName;
            descended = true;
          }
        }
        break;
      }
      if (entry.kind === 'object' || entry.kind === 'bridge') {
        const target = resolveRelationTarget(entry, curMap);
        if (target) {
          curRelPath = [...curRelPath, parts[i]];
          curMap = target.mapName;
          curModel = target.modelName;
        } else break;
      } else break;
    }

    // If the rule has an inner condition (arrayRule / aggregate), recurse into it
    // with the descended model context, AND inject the model-anchored wheres at this hop.
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
      return { ...rule, condition: inner } as Condition;
    }

    // No descent (scalar field on current model) — just return the rule unchanged.
    // Wheres for THIS model visit are handled at the parent's `condition` injection
    // or at the root by applyLens.
    void isRelation;
    return rule;
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
