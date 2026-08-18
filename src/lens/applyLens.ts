import { ArrayOperator } from '../operator.ts';
import type { Condition } from '../types.ts';
import type { Policy } from './policy.ts';
import { resolvePolicy, resolveVisit } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

// gloss
const wrapWithWheres = (rule: Condition, wheres: Condition[]): Condition => {
  if (wheres.length === 0) return rule;
  return { all: [...wheres, rule] };
};

// gloss
export const prefixConditionFields = (cond: Condition, prefix: string): Condition => {
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
    // why: fail closed — path-ref semantics don't survive re-rooting; guessing emits a wrong grant
    if ('path' in cond && cond.path !== undefined) {
      throw new Error(
        `applyLens: cannot re-root a relation grant with a path reference ('${String(cond.path)}') ` +
          `under '${prefix}'. Author the grant without 'path', or anchor it at the relation itself.`,
      );
    }
    // why: fail closed — a nested array/aggregate condition is row-scoped to another anchor
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

// gloss
const collectHopWheres = (policy: Policy, hops: RelationHop[]): Condition[] => {
  const out: Condition[] = [];
  for (const hop of hops) {
    const effect = resolveVisit(policy, hop.map, hop.model, hop.relPath);
    if (effect.whereClauses.length === 0) continue;
    // why: fail closed — a to-many hop has no scalar path to AND; dropping it leaves the grant unenforced
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

// gloss
const injectIntoArrayCondition = (
  innerCondition: Condition,
  whereClause: Condition,
): Condition => ({
  all: [whereClause, innerCondition],
});

// gloss
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

  if ('field' in rule && typeof rule.field === 'string' && rule.field !== '') {
    const fieldMap = policy.lens.maps[mapName];
    const model = fieldMap?.models[modelName];
    if (!model) return rule;
    const parts = rule.field.split('.');
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
      if (entry.kind !== 'object' && entry.kind !== 'bridge') break;
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

    if ('condition' in rule && rule.condition !== undefined && descended) {
      const effectAtDescent = resolveVisit(policy, curMap, curModel, curRelPath);
      let inner = rewriteRule(rule.condition, policy, curMap, curModel, curRelPath);
      const arrayOp = 'arrayOperator' in rule ? (rule.arrayOperator as ArrayOperator) : undefined;
      const allGrants: Condition[] = [];
      for (const whereClause of effectAtDescent.whereClauses) {
        if (arrayOp === ArrayOperator.all) {
          // why: filter-first — a per-row negate implication is unsound under a window and partial-field semantics
          allGrants.push(whereClause);
        } else if (arrayOp) {
          inner = injectIntoArrayCondition(inner, whereClause);
        } else {
          inner = { all: [whereClause, inner] };
        }
      }
      const existingFilter = (rule as { filter?: Condition }).filter;
      const rewritten = (
        allGrants.length
          ? {
              ...rule,
              condition: inner,
              filter:
                existingFilter !== undefined
                  ? { all: [existingFilter, ...allGrants] }
                  : allGrants.length === 1
                    ? allGrants[0]
                    : { all: allGrants },
            }
          : { ...rule, condition: inner }
      ) as Condition;
      return wrapWithWheres(rewritten, collectHopWheres(policy, relationHops.slice(0, -1)));
    }

    return wrapWithWheres(rule, collectHopWheres(policy, relationHops));
  }

  return rule;
};

// gloss
export const applyLens = (rule: Condition, lensOrNarrowing: Lens | LensNarrowing): Condition => {
  const policy = resolvePolicy(lensOrNarrowing);
  const rootEffect = resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);

  const rewritten = rewriteRule(rule, policy, policy.lens.mapName, policy.lens.model, []);

  return wrapWithWheres(rewritten, rootEffect.whereClauses);
};
