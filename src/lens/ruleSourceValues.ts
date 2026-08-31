import type { DateOperator, Operator } from '../operator';
import { DATE_OPERATOR_CATALOG, FIELD_OPERATOR_CATALOG } from '../operatorCatalog';
import { own } from '../own';
import { type ConditionNode, isRelationNode, visitCondition } from '../traverse.ts';
import type { Condition, RuleValue } from '../types.ts';
import { resolvePolicy } from './policy.ts';
import { projectByPath } from './projectByPath.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * The values one rule compares at one declared source — keyed the way `projectByPath`
 * keys the source (`path` + `field`), so the caller can join it back to the source's
 * model without spelling a path of its own.
 */
export type RuleSourceValues = {
  path: string;
  mapName: string;
  model: string;
  field: string;
  /** Every literal a leaf at this source compared against; list operators flattened, deduped. */
  values: RuleValue[];
  /**
   * A leaf at this source took its value from `path` / `bind` / `variable` instead of naming
   * one. `values` cannot be complete, so a caller deciding anything from it must fail closed.
   */
  dynamic: boolean;
};

const DYNAMIC_KEYS = ['path', 'bind', 'variable'] as const;

const comparesAValue = (node: ConditionNode): boolean => {
  if (typeof node.operator === 'string') {
    return own(FIELD_OPERATOR_CATALOG, node.operator as Operator)?.valueShape !== 'none';
  }
  if (typeof node.dateOperator === 'string') {
    return own(DATE_OPERATOR_CATALOG, node.dateOperator as DateOperator)?.valueShape !== 'none';
  }
  return false;
};

const literals = (value: unknown): RuleValue[] =>
  Array.isArray(value) ? value.flatMap(literals) : [value as RuleValue];

/**
 * Which values a rule names at each source the lens declares — the lens owns the
 * vocabulary, so it answers questions about it; callers never spell a path. A leaf reaches a
 * source by its absolute path through the lens: nested (`{ field: 'orders', arrayOperator,
 * condition: { field: 'sku' } }`) and dotted (`{ field: 'orders.sku' }`) spellings are one path.
 * Quantifier- and operator-blind on purpose — a `none` relation names its value as much as an
 * `any` one, `notIn` as much as `in` — except that operators which take no value (`exists`,
 * `isEmpty`, …) contribute nothing. A relation node's own comparison (an aggregate's threshold)
 * belongs to the aggregate, not to a source. Sources under relations the narrowing does not
 * declare, or beneath a Json column, are not sources; leaves there are silent.
 */
export const ruleSourceValues = (
  lensOrNarrowing: Lens | LensNarrowing,
  rule: Condition,
): RuleSourceValues[] => {
  const projection = projectByPath(lensOrNarrowing);
  const root = resolvePolicy(lensOrNarrowing).lens.model;
  const out = new Map<string, RuleSourceValues>();

  const record = (segments: string[], node: ConditionNode): void => {
    if (segments.length === 0) return;
    const field = segments[segments.length - 1];
    const path = [root, ...segments.slice(0, -1)].join('.');
    const visit = projection.get(path);
    if (!visit || !own(visit.sources, field)) return;

    const key = `${path}|${field}`;
    let entry = out.get(key);
    if (!entry) {
      entry = {
        path,
        mapName: visit.mapName,
        model: visit.modelName,
        field,
        values: [],
        dynamic: false,
      };
      out.set(key, entry);
    }
    if (DYNAMIC_KEYS.some((k) => k in node)) entry.dynamic = true;
    if (!('value' in node) || !comparesAValue(node)) return;
    for (const literal of literals(node.value)) {
      if (!entry.values.some((seen) => Object.is(seen, literal))) entry.values.push(literal);
    }
  };

  const walk = (condition: Condition, prefix: string[]): void => {
    visitCondition(condition, {
      enter: (node) => {
        if (isRelationNode(node)) return;
        if (typeof node.field === 'string') record([...prefix, ...node.field.split('.')], node);
      },
      descend: (node) => {
        const anchor =
          typeof node.field === 'string' ? [...prefix, ...node.field.split('.')] : prefix;
        if (node.condition !== undefined) walk(node.condition as Condition, anchor);
        if (node.filter !== undefined) walk(node.filter as Condition, anchor);
        return false;
      },
    });
  };

  walk(rule, []);
  return [...out.values()];
};
