import { bridgeJoinKeys } from '../fieldMap/endpointKey.ts';
import { isRelationEntry } from '../fieldMap/entry.ts';
import { relationTargetOf } from '../fieldMap/walk.ts';
import type { ArrayOperator } from '../operator.ts';
import { parseScopeRef, readScopeRef } from '../scope.ts';
import {
  conditionShape,
  elementRefs,
  isLogicalNode,
  isRelationNode,
  valueRefRoles,
  visitCondition,
} from '../traverse.ts';
import type { Condition } from '../types.ts';
import { arrayFitViolation } from './fieldFit.ts';
import {
  type LensPathHop,
  lensPathEnd,
  lensRootScope,
  type Policy,
  stepIntoField,
  type VisitScope,
} from './policy.ts';

/**
 * A model visit a rule, value expression or categorization reads through a lens, with the map it
 * belongs to and the dotted relation path from the root (`''` for the root model itself).
 */
export type ModelVisit = {
  mapName: string;
  model: string;
  path: string;
};

/**
 * Every model visit a condition reads through the lens, sorted by `path`, `mapName`, `model`.
 * Walks the condition under the same gate as `validateRuleInLens` (`stepIntoField` / `lensPathEnd`,
 * `conditionShape`, `arrayFitViolation`) — invalid or hidden paths (including plain paths
 * continuing past a to-many relation, ambiguous nodes, non-list array rules and relation-valued
 * value refs) are silent and left for the gate to report. Each crossed relation records its target
 * visit; a hop whose join key sits on the near model (a forward FK or a joined bridge) also records
 * the near visit, so anchor-side FK edits invalidate rules reading through it without falsely
 * adding the anchor for back-relations. Describes what the rule itself reads (not the lens's own
 * clamps), matching `paths` and `sources`.
 */
export const collectModelVisits = (policy: Policy, condition: Condition): ModelVisit[] => {
  const found = new Map<string, ModelVisit>();
  const add = (mapName: string, model: string, relPath: readonly string[]): void => {
    const path = relPath.join('.');
    found.set(`${path}\u0000${mapName}\u0000${model}`, { mapName, model, path });
  };

  const recordHops = (hops: readonly LensPathHop[]): void => {
    for (const hop of hops) {
      const target = relationTargetOf(hop.entry, hop.mapName);
      if (target) {
        const ownsJoinKey =
          (hop.entry.fromFields?.length ?? 0) > 0 ||
          bridgeJoinKeys(policy.lens.bridges, hop.mapName, hop.model, hop.entry) !== null;
        if (ownsJoinKey) add(hop.mapName, hop.model, hop.relPath);
        add(target.mapName, target.modelName, [...hop.relPath, hop.field]);
      } else {
        add(hop.mapName, hop.model, hop.relPath);
      }
    }
  };

  const root = lensRootScope(policy);
  visitCondition<readonly VisitScope[]>(
    condition,
    (node, scopes) => {
      if (conditionShape(node as Record<string, unknown>) === null) return false;
      if (isLogicalNode(node)) return;

      for (const { ref } of valueRefRoles(node as Record<string, unknown>)) {
        const target = parseScopeRef(ref) ? readScopeRef(ref, scopes) : { scope: root, path: ref };
        if ('outOfBounds' in target || target.scope.open) continue;
        const walked = lensPathEnd(policy, target.scope, target.path);
        // A value ref reads a column, not a relation (validateRuleInLens rejects relation refs).
        if (walked && !isRelationEntry(walked.entry)) recordHops(walked.hops);
      }

      let next: VisitScope = scopes[scopes.length - 1];
      if (typeof node.field === 'string' && node.field !== '') {
        const step = stepIntoField(policy, scopes, node.field);
        if ('issue' in step) return false;
        if (step.walked) {
          recordHops(step.walked.hops);
          if (
            'arrayOperator' in node &&
            arrayFitViolation(node.field, node.arrayOperator as ArrayOperator, step.walked.entry)
          )
            return false;
          // A scalar list (e.g. String[]) iterates scalar elements, not rows of the owning model.
          next =
            isRelationNode(node) && !isRelationEntry(step.walked.entry)
              ? { ...step.next, open: true }
              : step.next;
        } else {
          next = step.next;
        }
      }

      if (!next.open) {
        for (const ref of elementRefs(node as Record<string, unknown>)) {
          if (ref === '') continue;
          const walked = lensPathEnd(policy, next, ref);
          if (walked) recordHops(walked.hops);
        }
      }

      return [...scopes, next];
    },
    [root],
  );

  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, visit]) => visit);
};
