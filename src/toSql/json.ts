import { resolveCaseInsensitive } from '../engineGlobals';
import { hasNoOperand } from '../field';
import { splitNull } from '../number';
import { Operator } from '../operator';
import { NEGATED_OPERATORS } from '../operatorCatalog';
import { readPattern } from '../pattern';
import type { Rule } from '../types';
import { noOperandSql, orderedSql, orNull } from './compare';
import { nextParam } from './params';
import { escapeLikePattern } from './quoting';
import type { BuilderState } from './types';

// A Json value compared as JSON, as check() compares it: by value — a list or an object deeply —
// and never across types; JSON null is null; string operators read strings, and `contains` is
// also exact membership in an array.

/**
 * `rule` against the Json value `jsonb` (a column, or a path read with `->`), its operand known
 * now: `value`, or a range's two ends.
 */
export const buildJsonComparison = (
  rule: Rule,
  jsonb: string,
  value: unknown,
  state: BuilderState,
): string => {
  const j = `NULLIF(${jsonb}, 'null'::jsonb)`;
  const type = `jsonb_typeof(${j})`;
  const text = `(${j} #>> '{}')`;
  const json = (v: unknown): string => `${nextParam(state, JSON.stringify(v))}::jsonb`;
  const ci = resolveCaseInsensitive(rule.caseInsensitive);
  const lc = (expr: string): string => (ci ? `LOWER(${expr})` : expr);
  const negated = NEGATED_OPERATORS.includes(rule.operator);
  const not = (expr: string): string => orNull(j, `NOT (${expr})`);

  if (hasNoOperand(rule, value)) return noOperandSql(j, negated);

  /** One value: a string compares case-insensitively under the flag; anything else exactly. */
  const equal = (v: unknown): string =>
    ci && typeof v === 'string'
      ? `(${type} = 'string' AND LOWER(${text}) = LOWER(${nextParam(state, v)}))`
      : `${j} = ${json(v)}`;
  /** A string operator reads a string: `pattern` is a LIKE pattern. */
  const like = (pattern: string): string =>
    `(${type} = 'string' AND ${lc(text)} LIKE ${lc(nextParam(state, pattern))})`;
  const contains = (v: unknown): string =>
    `(${like(`%${escapeLikePattern(String(v))}%`)} OR (${type} = 'array' AND ${j} @> ${json([v])}))`;

  switch (rule.operator) {
    case Operator.equals:
      return value === null ? `${j} IS NULL` : equal(value);
    case Operator.notEquals:
      return value === null ? `${j} IS NOT NULL` : not(equal(value));
    case Operator.in:
    case Operator.notIn: {
      const { values, hasNull } = splitNull(value);
      const anyOf = values.length ? `(${values.map(equal).join(' OR ')})` : 'FALSE';
      if (rule.operator === Operator.in) return hasNull ? `(${anyOf} OR ${j} IS NULL)` : anyOf;
      return hasNull ? `(NOT ${anyOf} AND ${j} IS NOT NULL)` : not(anyOf);
    }
    case Operator.between:
    case Operator.notBetween: {
      const [low, high] = value as [unknown, unknown];
      const within = `(${type} = jsonb_typeof(${json(low)}) AND ${j} BETWEEN ${json(low)} AND ${json(high)})`;
      return rule.operator === Operator.between ? within : not(within);
    }
    case Operator.contains:
      return contains(value);
    case Operator.notContains:
      return not(contains(value));
    case Operator.startsWith:
      return like(`${escapeLikePattern(String(value))}%`);
    case Operator.endsWith:
      return like(`%${escapeLikePattern(String(value))}`);
    case Operator.notStartsWith:
      return not(like(`${escapeLikePattern(String(value))}%`));
    case Operator.notEndsWith:
      return not(like(`%${escapeLikePattern(String(value))}`));
    case Operator.matches:
    case Operator.notMatches: {
      const pattern = nextParam(state, readPattern(value as string | RegExp).source);
      const match = `(${type} = 'string' AND ${text} ~ ${pattern})`;
      return rule.operator === Operator.matches ? match : not(match);
    }
  }
  const symbol = orderedSql(rule.operator, 'field')?.symbol;
  if (symbol) return `(${type} = jsonb_typeof(${json(value)}) AND ${j} ${symbol} ${json(value)})`;
  throw new Error(`Operator '${rule.operator}' is not supported on a Json value in SQL`);
};
