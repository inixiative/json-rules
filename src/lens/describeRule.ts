import { ALL_TARGETS, type RuleTarget } from '../operatorCatalog';
import { isLogicalNode, visitCondition } from '../traverse';
import type { Condition } from '../types';
import { type ValidationIssue, validateRule } from '../validate';
import type { Policy } from './policy.ts';
import { lensRootScope, resolvePolicy, stepIntoField, type VisitScope } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { validateRuleInLens } from './validateRuleInLens.ts';

export type RuleDescription = {
  sources: string[];
  bridgesCrossed: boolean;
  supportedTargets: RuleTarget[];
  /** What the lens refuses in the rule — validateRuleInLens's issues. */
  errors: ValidationIssue[];
};

type Acc = {
  policy: Policy;
  sources: Set<string>;
  bridgesCrossed: boolean;
};

const visit = (rule: Condition, acc: Acc): void =>
  visitCondition<readonly VisitScope[]>(
    rule,
    (node, scopes) => {
      acc.sources.add(scopes[scopes.length - 1].mapName);
      if (isLogicalNode(node)) return;
      if (typeof node.field !== 'string' || node.field === '') return;
      const step = stepIntoField(acc.policy, scopes, node.field);
      if ('issue' in step) return false;
      if (step.walked) {
        acc.sources.add(step.walked.mapName);
        if (step.walked.entry.kind === 'bridge' || step.walked.mapName !== step.from.mapName)
          acc.bridgesCrossed = true;
      }
      // `filter` and `condition` are both evaluated against the descended target.
      return [...scopes, step.next];
    },
    [lensRootScope(acc.policy)],
  );

export const describeRule = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): RuleDescription => {
  const policy = resolvePolicy(lensOrNarrowing);
  const acc: Acc = { policy, sources: new Set(), bridgesCrossed: false };
  visit(rule, acc);
  // A target takes the rule when validateRule passes it there; a bridge joins only in memory.
  return {
    sources: [...acc.sources].sort(),
    bridgesCrossed: acc.bridgesCrossed,
    supportedTargets: ALL_TARGETS.filter(
      (target) => (target === 'check' || !acc.bridgesCrossed) && validateRule(rule, { target }).ok,
    ),
    errors: validateRuleInLens(rule, lensOrNarrowing).errors,
  };
};
