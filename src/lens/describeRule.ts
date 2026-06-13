import { isOperatorSupportedForTarget, type RuleTarget } from '../operatorCatalog';
import type { ArrayRule, Condition, WindowFields } from '../types';
import { extremalRewrite, hasWindow } from '../window';
import type { Policy } from './policy.ts';
import { resolvePolicy, walkLensPath } from './policy.ts';
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

const visit = (
  cond: Condition,
  acc: Acc,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): void => {
  if (typeof cond === 'boolean') return;
  acc.sources.add(mapName);

  if ('all' in cond) {
    for (const c of cond.all) visit(c, acc, mapName, modelName, relPath);
    return;
  }
  if ('any' in cond) {
    for (const c of cond.any) visit(c, acc, mapName, modelName, relPath);
    return;
  }
  if ('if' in cond) {
    visit(cond.if, acc, mapName, modelName, relPath);
    visit(cond.then, acc, mapName, modelName, relPath);
    if (cond.else !== undefined) visit(cond.else, acc, mapName, modelName, relPath);
    return;
  }

  const record = cond as Record<string, unknown>;
  if (typeof record.operator === 'string') restrictByOperator(acc, record.operator);
  if (typeof record.dateOperator === 'string') restrictByOperator(acc, record.dateOperator);
  if (typeof record.arrayOperator === 'string') restrictByOperator(acc, record.arrayOperator);
  restrictByWindow(acc, record);
  if (record.filter !== undefined) {
    visit(record.filter as Condition, acc, mapName, modelName, relPath);
  }

  let nextMap = mapName;
  let nextModel = modelName;
  let nextRelPath = relPath;

  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const walked = walkLensPath(acc.policy, mapName, modelName, relPath, cond.field);
    if (!walked) {
      acc.violations.push(cond.field);
      return;
    }
    acc.sources.add(walked.mapName);
    if (walked.mapName !== mapName) acc.bridgesCrossed = true;

    if (walked.entry.kind === 'object' || walked.entry.kind === 'bridge') {
      if (walked.entry.kind === 'bridge') acc.bridgesCrossed = true;
      const target =
        walked.entry.kind === 'object'
          ? { mapName: walked.mapName, modelName: walked.entry.type }
          : {
              mapName: walked.entry.type.split(':')[0] ?? walked.mapName,
              modelName: walked.entry.type.split(':')[1] ?? walked.entry.type,
            };
      nextMap = target.mapName;
      nextModel = target.modelName;
      nextRelPath = [...walked.relPath, walked.terminalFieldName];
    }
  }

  if ('condition' in cond && cond.condition !== undefined) {
    visit(cond.condition, acc, nextMap, nextModel, nextRelPath);
  }
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
  visit(rule, acc, policy.lens.mapName, policy.lens.model, []);
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
