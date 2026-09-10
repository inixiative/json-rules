import { isOperatorSupportedForTarget, type RuleTarget } from '../operatorCatalog';
import { parseScopeRef, resolveScopeRef } from '../scope';
import type { ArrayRule, Condition, WindowFields } from '../types';
import { extremalRewrite, hasWindow } from '../window';
import type { Policy } from './policy.ts';
import { resolvePolicy, walkLensPath } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { isJsonEntry } from './walk.ts';

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

const restrictByOperator = (acc: Acc, operator: string): void => {
  for (const t of [...acc.targets]) {
    if (!isOperatorSupportedForTarget(operator as never, t)) acc.targets.delete(t);
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

// Scope refs compile nowhere but `path: '$.x'` on toSql (a same-row column comparison).
const restrictByScopeRefs = (acc: Acc, cond: Record<string, unknown>): void => {
  if (typeof cond.field === 'string' && parseScopeRef(cond.field)) {
    acc.targets.delete('toSql');
    acc.targets.delete('toPrisma');
  }
  const pathRef = typeof cond.path === 'string' ? parseScopeRef(cond.path) : null;
  if (pathRef) {
    acc.targets.delete('toPrisma');
    if (pathRef.depth > 1) acc.targets.delete('toSql');
  }
};

type VisitScope = {
  mapName: string;
  modelName: string;
  relPath: readonly string[];
  open: boolean;
};

const visit = (cond: Condition, acc: Acc, scopes: readonly VisitScope[]): void => {
  if (typeof cond === 'boolean') return;
  const here = scopes[scopes.length - 1];
  acc.sources.add(here.mapName);

  if ('all' in cond) {
    for (const c of cond.all) visit(c, acc, scopes);
    return;
  }
  if ('any' in cond) {
    for (const c of cond.any) visit(c, acc, scopes);
    return;
  }
  if ('if' in cond) {
    visit(cond.if, acc, scopes);
    visit(cond.then, acc, scopes);
    if (cond.else !== undefined) visit(cond.else, acc, scopes);
    return;
  }

  const record = cond as Record<string, unknown>;
  if (typeof record.operator === 'string') restrictByOperator(acc, record.operator);
  if (typeof record.dateOperator === 'string') restrictByOperator(acc, record.dateOperator);
  if (typeof record.arrayOperator === 'string') restrictByOperator(acc, record.arrayOperator);
  restrictByWindow(acc, record);
  restrictByScopeRefs(acc, record);

  if (typeof record.path === 'string' && parseScopeRef(record.path)) {
    const ref = resolveScopeRef(record.path, scopes);
    if ('outOfBounds' in ref) acc.violations.push(record.path);
  }

  let next: VisitScope = here;

  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const target = resolveScopeRef(cond.field, scopes);
    if ('outOfBounds' in target) {
      acc.violations.push(cond.field);
      return;
    }
    if (target.scope.open) {
      next = target.scope;
    } else {
      const { mapName, modelName, relPath } = target.scope;
      const walked = walkLensPath(acc.policy, mapName, modelName, relPath, target.path);
      if (!walked) {
        acc.violations.push(cond.field);
        return;
      }
      acc.sources.add(walked.mapName);
      if (walked.mapName !== mapName) acc.bridgesCrossed = true;
      // A Json column's members are undeclared — nested refs below it resolve at evaluation time.
      const open = isJsonEntry(walked.entry);

      if (walked.entry.kind === 'object' || walked.entry.kind === 'bridge') {
        if (walked.entry.kind === 'bridge') acc.bridgesCrossed = true;
        const relation =
          walked.entry.kind === 'object'
            ? { mapName: walked.mapName, modelName: walked.entry.type }
            : {
                mapName: walked.entry.type.split(':')[0] ?? walked.mapName,
                modelName: walked.entry.type.split(':')[1] ?? walked.entry.type,
              };
        next = { ...relation, relPath: [...walked.relPath, walked.terminalFieldName], open };
      } else {
        next = { ...target.scope, open };
      }
    }
  }

  // `filter` and `condition` are both evaluated against the descended target.
  const below = [...scopes, next];
  if (record.filter !== undefined) visit(record.filter as Condition, acc, below);
  if ('condition' in cond && cond.condition !== undefined) visit(cond.condition, acc, below);
};

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
  visit(rule, acc, [
    { mapName: policy.lens.mapName, modelName: policy.lens.model, relPath: [], open: false },
  ]);
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
