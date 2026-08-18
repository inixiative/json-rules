import type { FieldKind } from '../operatorCatalog.ts';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

// gloss
const COERCIBLE_KINDS = new Set([
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Boolean',
  'String',
]);

type Scope = { mapName: string; modelName: string };
type ResolvedField = { entry: FieldMapEntry; mapName: string };

// gloss
const resolveField = (lens: Lens, scope: Scope, fieldPath: string): ResolvedField | undefined => {
  const segments = fieldPath.split('.');
  let { mapName, modelName } = scope;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = lens.maps[mapName]?.models[modelName]?.fields[segments[i]];
    if (!entry) return undefined;
    if (i === segments.length - 1) return { entry, mapName };
    if (entry.kind !== 'object' && entry.kind !== 'bridge') return undefined;
    const target = resolveRelationTarget(entry, mapName);
    if (!target) return undefined;
    ({ mapName, modelName } = target);
  }
  return undefined;
};

// gloss
const itemScope = (lens: Lens, scope: Scope, fieldPath: string | undefined): Scope | undefined => {
  if (!fieldPath) return undefined;
  const resolved = resolveField(lens, scope, fieldPath);
  if (!resolved || (resolved.entry.kind !== 'object' && resolved.entry.kind !== 'bridge'))
    return undefined;
  const target = resolveRelationTarget(resolved.entry, resolved.mapName);
  return target ?? undefined;
};

// gloss
const stampCondition = (condition: Condition, lens: Lens, scope: Scope): Condition => {
  if (typeof condition === 'boolean') return condition;

  if ('all' in condition)
    return { ...condition, all: condition.all.map((c) => stampCondition(c, lens, scope)) };
  if ('any' in condition)
    return { ...condition, any: condition.any.map((c) => stampCondition(c, lens, scope)) };
  if ('if' in condition) {
    return {
      ...condition,
      if: stampCondition(condition.if, lens, scope),
      then: stampCondition(condition.then, lens, scope),
      ...(condition.else !== undefined
        ? { else: stampCondition(condition.else, lens, scope) }
        : {}),
    };
  }

  if ('arrayOperator' in condition || 'aggregate' in condition) {
    const target = itemScope(lens, scope, condition.field);
    if (!target) return condition;
    return {
      ...condition,
      ...(condition.condition !== undefined
        ? { condition: stampCondition(condition.condition, lens, target) }
        : {}),
      ...(condition.filter !== undefined
        ? { filter: stampCondition(condition.filter, lens, target) }
        : {}),
    };
  }

  if ('dateOperator' in condition) return condition;

  if ('operator' in condition) {
    if (condition.coerceType) return condition;
    const resolved = resolveField(lens, scope, condition.field);
    if (!resolved || resolved.entry.kind !== 'scalar' || !COERCIBLE_KINDS.has(resolved.entry.type))
      return condition;
    return { ...condition, coerceType: resolved.entry.type as FieldKind };
  }

  return condition;
};

// gloss
export const stampCoercions = (
  condition: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): Condition => {
  const { lens } = resolvePolicy(lensOrNarrowing);
  return stampCondition(condition, lens, { mapName: lens.mapName, modelName: lens.model });
};
