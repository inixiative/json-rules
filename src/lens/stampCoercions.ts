import type { FieldKind } from '../operatorCatalog.ts';
import { own } from '../own';
import { resolveScopeRef } from '../scope';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { resolveRelationTarget } from './walk.ts';

// Kinds check() knows how to coerce — see coerceScalar in src/field.ts.
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

/**
 * Resolves a dotted path to its declared entry. Returns undefined when the path descends past
 * a leaf — including below a Json boundary, where the value's kind is undeclared and therefore
 * uncoercible, so the rule is left unstamped.
 */
const resolveField = (
  lens: Lens,
  scopes: readonly Scope[],
  fieldPath: string,
): ResolvedField | undefined => {
  const target = resolveScopeRef(fieldPath, scopes);
  if ('outOfBounds' in target) return undefined;
  const segments = target.path.split('.');
  let { mapName, modelName } = target.scope;
  for (let i = 0; i < segments.length; i += 1) {
    const entry = own(lens.maps[mapName]?.models[modelName]?.fields, segments[i]);
    if (!entry) return undefined;
    if (i === segments.length - 1) return { entry, mapName };
    if (entry.kind !== 'object' && entry.kind !== 'bridge') return undefined;
    const target = resolveRelationTarget(entry, mapName);
    if (!target) return undefined;
    ({ mapName, modelName } = target);
  }
  return undefined;
};

/**
 * The model scope a nested array/aggregate condition is evaluated against. Undefined when the
 * field is not a relation — a Json array's elements are undeclared, so nothing below is stamped.
 */
const itemScope = (
  lens: Lens,
  scopes: readonly Scope[],
  fieldPath: string | undefined,
): Scope | undefined => {
  if (!fieldPath) return undefined;
  const resolved = resolveField(lens, scopes, fieldPath);
  if (!resolved || (resolved.entry.kind !== 'object' && resolved.entry.kind !== 'bridge'))
    return undefined;
  const target = resolveRelationTarget(resolved.entry, resolved.mapName);
  return target ?? undefined;
};

const stampCondition = (condition: Condition, lens: Lens, scopes: readonly Scope[]): Condition => {
  if (typeof condition === 'boolean') return condition;

  if ('all' in condition)
    return { ...condition, all: condition.all.map((c) => stampCondition(c, lens, scopes)) };
  if ('any' in condition)
    return { ...condition, any: condition.any.map((c) => stampCondition(c, lens, scopes)) };
  if ('if' in condition) {
    return {
      ...condition,
      if: stampCondition(condition.if, lens, scopes),
      then: stampCondition(condition.then, lens, scopes),
      ...(condition.else !== undefined
        ? { else: stampCondition(condition.else, lens, scopes) }
        : {}),
    };
  }

  // Array/aggregate rules: the nested condition/filter evaluate per item, so they
  // stamp against the relation's target model. The aggregate comparison itself is
  // numeric by contract and takes no coercion.
  if ('arrayOperator' in condition || 'aggregate' in condition) {
    const target = itemScope(lens, scopes, condition.field);
    if (!target) return condition;
    const below = [...scopes, target];
    return {
      ...condition,
      ...(condition.condition !== undefined
        ? { condition: stampCondition(condition.condition, lens, below) }
        : {}),
      ...(condition.filter !== undefined
        ? { filter: stampCondition(condition.filter, lens, below) }
        : {}),
    };
  }

  if ('dateOperator' in condition) return condition;

  if ('operator' in condition) {
    if (condition.coerceType) return condition;
    const resolved = resolveField(lens, scopes, condition.field);
    if (!resolved || resolved.entry.kind !== 'scalar' || !COERCIBLE_KINDS.has(resolved.entry.type))
      return condition;
    return { ...condition, coerceType: resolved.entry.type as FieldKind };
  }

  return condition;
};

// Walk a condition and stamp coerceType onto every field rule from the lens's
// field map — the explicit dual of the server's coerceValueForField: the rule
// carries its coercion, check() never infers types from values.
export const stampCoercions = (
  condition: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): Condition => {
  const { lens } = resolvePolicy(lensOrNarrowing);
  return stampCondition(condition, lens, [{ mapName: lens.mapName, modelName: lens.model }]);
};
