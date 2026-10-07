import {
  isOperatorSupportedForTarget,
  type OperatorFamily,
  type RuleTarget,
} from '../operatorCatalog';
import { parseScopeRef, readScopeRef } from '../scope';
import { isLogicalNode, valueRefRoles, valueRefs, visitCondition } from '../traverse';
import type { ArrayRule, Condition, WindowFields } from '../types';
import { extremalRewrite, hasWindow } from '../window';
import type { Policy } from './policy.ts';
import { lensRootScope, resolvePolicy, stepIntoField, type VisitScope } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type RuleDescription = {
  sources: string[];
  bridgesCrossed: boolean;
  supportedTargets: RuleTarget[];
  violations: string[];
};

const ALL_TARGETS: readonly RuleTarget[] = ['check', 'toPrisma', 'toSql'];

type Acc = {
  policy: Policy;
  sources: Set<string>;
  bridgesCrossed: boolean;
  targets: Set<RuleTarget>;
  violations: string[];
};

const restrictByOperator = (acc: Acc, operator: string, family: OperatorFamily): void => {
  for (const t of [...acc.targets]) {
    if (!isOperatorSupportedForTarget(operator, family, t)) acc.targets.delete(t);
  }
};

const restrictByWindow = (acc: Acc, cond: Record<string, unknown>): void => {
  if (!hasWindow(cond as unknown as WindowFields)) return;
  acc.targets.delete('toSql');
  const isAggregate = 'aggregate' in cond;
  if (isAggregate || extremalRewrite(cond as unknown as ArrayRule) === null) {
    acc.targets.delete('toPrisma');
  }
};

// Scope refs compile nowhere but `$.x` value refs on toSql (same-row column arithmetic) — and
// not a date offset's.
const restrictByScopeRefs = (acc: Acc, cond: Record<string, unknown>): void => {
  if (typeof cond.field === 'string' && parseScopeRef(cond.field)) {
    acc.targets.delete('toSql');
    acc.targets.delete('toPrisma');
  }
  for (const { ref, role } of valueRefRoles(cond)) {
    const pathRef = parseScopeRef(ref);
    if (!pathRef) continue;
    acc.targets.delete('toPrisma');
    // A date offset read per row is a stored `{ ago }` Postgres can't apply.
    if (pathRef.depth > 1 || role === 'shift') acc.targets.delete('toSql');
  }
};

const visit = (rule: Condition, acc: Acc): void =>
  visitCondition<readonly VisitScope[]>(
    rule,
    (node, scopes) => {
      acc.sources.add(scopes[scopes.length - 1].mapName);
      if (isLogicalNode(node)) return;
      if (typeof node.operator === 'string') restrictByOperator(acc, node.operator, 'field');
      if (typeof node.dateOperator === 'string') restrictByOperator(acc, node.dateOperator, 'date');
      if (typeof node.arrayOperator === 'string')
        restrictByOperator(acc, node.arrayOperator, 'array');
      restrictByWindow(acc, node);
      restrictByScopeRefs(acc, node);

      for (const ref of valueRefs(node)) {
        if (!parseScopeRef(ref)) continue;
        if ('outOfBounds' in readScopeRef(ref, scopes)) acc.violations.push(ref);
      }

      if (typeof node.field !== 'string' || node.field === '') return;
      const step = stepIntoField(acc.policy, scopes, node.field);
      if ('violation' in step) {
        acc.violations.push(node.field);
        return false;
      }
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
  const acc: Acc = {
    policy,
    sources: new Set(),
    bridgesCrossed: false,
    targets: new Set(ALL_TARGETS),
    violations: [],
  };
  visit(rule, acc);
  if (acc.bridgesCrossed) {
    for (const t of [...acc.targets]) if (t !== 'check') acc.targets.delete(t);
  }
  return {
    sources: [...acc.sources].sort(),
    bridgesCrossed: acc.bridgesCrossed,
    supportedTargets: ALL_TARGETS.filter((t) => acc.targets.has(t)),
    violations: acc.violations,
  };
};
