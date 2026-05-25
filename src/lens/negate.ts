import { ArrayOperator, DateOperator, Operator } from '../operator.ts';
import type { AggregateRule, ArrayRule, Condition, DateRule, Rule } from '../types.ts';

/**
 * Returns the logical inverse of a Condition using existing negative operators
 * from the DSL (no new `not` primitive). Used by applyLens when injecting a
 * `where` clause into an `arrayOperator: 'all'` — the filter-first rewrite is
 * `all({ any: [NOT(where), u] })` which requires NOT(where).
 *
 * For operators with no inverse in the DSL (startsWith, endsWith, exactly),
 * throws a clear error rather than silently producing wrong semantics.
 */

const RULE_OPERATOR_INVERSES: Partial<Record<Operator, Operator>> = {
  [Operator.equals]: Operator.notEquals,
  [Operator.notEquals]: Operator.equals,
  [Operator.lessThan]: Operator.greaterThanEquals,
  [Operator.lessThanEquals]: Operator.greaterThan,
  [Operator.greaterThan]: Operator.lessThanEquals,
  [Operator.greaterThanEquals]: Operator.lessThan,
  [Operator.in]: Operator.notIn,
  [Operator.notIn]: Operator.in,
  [Operator.contains]: Operator.notContains,
  [Operator.notContains]: Operator.contains,
  [Operator.matches]: Operator.notMatches,
  [Operator.notMatches]: Operator.matches,
  [Operator.between]: Operator.notBetween,
  [Operator.notBetween]: Operator.between,
  [Operator.isEmpty]: Operator.notEmpty,
  [Operator.notEmpty]: Operator.isEmpty,
  [Operator.exists]: Operator.notExists,
  [Operator.notExists]: Operator.exists,
  // startsWith / endsWith: no inverse in the current DSL — throw.
};

const DATE_OPERATOR_INVERSES: Record<DateOperator, DateOperator> = {
  [DateOperator.before]: DateOperator.onOrAfter,
  [DateOperator.after]: DateOperator.onOrBefore,
  [DateOperator.onOrBefore]: DateOperator.after,
  [DateOperator.onOrAfter]: DateOperator.before,
  [DateOperator.between]: DateOperator.notBetween,
  [DateOperator.notBetween]: DateOperator.between,
  [DateOperator.dayIn]: DateOperator.dayNotIn,
  [DateOperator.dayNotIn]: DateOperator.dayIn,
};

const negateRule = (rule: Rule): Rule => {
  const inverse = RULE_OPERATOR_INVERSES[rule.operator];
  if (!inverse) {
    throw new Error(
      `negate: operator '${rule.operator}' has no inverse in the DSL. ` +
        `Affects 'where' clauses used under arrayOperator: 'all'. ` +
        `Rewrite the where clause using an invertible operator, or add the inverse operator to the DSL.`,
    );
  }
  return { ...rule, operator: inverse };
};

const negateDateRule = (rule: DateRule): DateRule => {
  const inverse = DATE_OPERATOR_INVERSES[rule.dateOperator];
  return { ...rule, dateOperator: inverse };
};

const negateAggregateRule = (rule: AggregateRule): AggregateRule => {
  const inverse = RULE_OPERATOR_INVERSES[rule.operator];
  if (!inverse) {
    throw new Error(`negate: aggregate operator '${rule.operator}' has no inverse in the DSL.`);
  }
  return { ...rule, operator: inverse };
};

const negateArrayRule = (rule: ArrayRule): Condition => {
  switch (rule.arrayOperator) {
    case ArrayOperator.any:
      return { ...rule, arrayOperator: ArrayOperator.none };
    case ArrayOperator.none:
      return { ...rule, arrayOperator: ArrayOperator.any };
    case ArrayOperator.all:
      // NOT(all c) = any(NOT c) = "exists a row failing c"
      if (!rule.condition) throw new Error(`negate: arrayRule 'all' missing condition`);
      return { ...rule, arrayOperator: ArrayOperator.any, condition: negate(rule.condition) };
    case ArrayOperator.empty:
      return { ...rule, arrayOperator: ArrayOperator.notEmpty };
    case ArrayOperator.notEmpty:
      return { ...rule, arrayOperator: ArrayOperator.empty };
    case ArrayOperator.atLeast:
      if (rule.count === undefined) throw new Error(`negate: 'atLeast' missing count`);
      return { ...rule, arrayOperator: ArrayOperator.atMost, count: rule.count - 1 };
    case ArrayOperator.atMost:
      if (rule.count === undefined) throw new Error(`negate: 'atMost' missing count`);
      return { ...rule, arrayOperator: ArrayOperator.atLeast, count: rule.count + 1 };
    case ArrayOperator.exactly:
      throw new Error(
        `negate: arrayRule 'exactly' has no single-operator inverse. ` +
          `Rewrite as { any: [atMost n-1, atLeast n+1] } if needed.`,
      );
    default:
      throw new Error(`negate: unknown arrayOperator '${(rule as ArrayRule).arrayOperator}'`);
  }
};

export const negate = (cond: Condition): Condition => {
  if (typeof cond === 'boolean') return !cond;
  if ('all' in cond) return { any: cond.all.map(negate) }; // De Morgan
  if ('any' in cond) return { all: cond.any.map(negate) }; // De Morgan
  if ('if' in cond) {
    // NOT(if X then A else B) = if X then NOT(A) else NOT(B)
    // (proof: ¬((¬X∨A) ∧ (X∨B)) = (X∧¬A) ∨ (¬X∧¬B) = if X then ¬A else ¬B)
    // Without else: NOT(if X then A) = X ∧ ¬A
    if (cond.else !== undefined) {
      return { if: cond.if, then: negate(cond.then), else: negate(cond.else) };
    }
    return { all: [cond.if, negate(cond.then)] };
  }
  if ('arrayOperator' in cond) return negateArrayRule(cond);
  if ('dateOperator' in cond) return negateDateRule(cond);
  if ('aggregate' in cond) return negateAggregateRule(cond);
  if ('field' in cond && 'operator' in cond) return negateRule(cond);
  throw new Error('negate: unknown condition shape');
};
