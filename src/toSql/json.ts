import { resolveCaseInsensitive } from '../engineGlobals';
import { noCompiledForm, unorderedOperand } from '../errors';
import { hasNoOperand, lowerStrings } from '../field';
import { splitNull } from '../number';
import { Operator } from '../operator';
import { NEGATED_OPERATORS } from '../operatorCatalog';
import { postgresSource, readPattern } from '../pattern';
import type { Rule } from '../types';
import { noOperandSql, orderedSql, orNull } from './compare';
import { nextParam } from './params';
import { escapeLikePattern } from './quoting';
import type { BuilderState } from './types';

// A Json value compared as JSON, as check() compares it: by value — a list or an object deeply —
// and never across types; JSON null is null; string operators read strings, and `contains` is
// also exact membership in an array.

const holdsObject = (v: unknown): boolean =>
  Array.isArray(v) ? v.some(holdsObject) : typeof v === 'object' && v !== null;

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
  const unordered = unorderedOperand(rule.operator, value);
  if (unordered) throw unordered;

  // Under the flag check() lowers strings through lists, never inside objects. A list operand
  // without objects compares against the lowered JSON text: any object the value holds then
  // differs in type anyway.
  const lowered = (v: unknown[]): string => {
    if (holdsObject(v))
      throw noCompiledForm(
        'toSql',
        `A case-insensitive comparison of '${rule.field}' with a list holding objects`,
      );
    return json(lowerStrings(v));
  };
  /** One value: a string or a list compares case-insensitively under the flag; anything else
   *  exactly. */
  const equal = (v: unknown): string =>
    ci && typeof v === 'string'
      ? `(${type} = 'string' AND LOWER(${text}) = LOWER(${nextParam(state, v)}))`
      : ci && Array.isArray(v)
        ? `(${type} = 'array' AND LOWER(${j}::text)::jsonb = ${lowered(v)})`
        : `${j} = ${json(v)}`;
  /** A string operator reads a string: `pattern` is a LIKE pattern. */
  const like = (pattern: string): string =>
    `(${type} = 'string' AND ${lc(text)} LIKE ${lc(nextParam(state, pattern))})`;
  // An array member equal to `v`: `@>` reads an object or a list partially, and a string under
  // the flag compares lowered, so those compare element by element.
  const member = (v: unknown): string => {
    const element = (match: string): string =>
      `(CASE WHEN ${type} = 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${j}) AS e WHERE ${match}) ELSE FALSE END)`;
    if (ci && typeof v === 'string')
      return element(
        `jsonb_typeof(e) = 'string' AND LOWER(e #>> '{}') = LOWER(${nextParam(state, v)})`,
      );
    if (ci && Array.isArray(v)) return element(`LOWER(e::text)::jsonb = ${lowered(v)}`);
    return typeof v === 'object' && v !== null
      ? element(`e = ${json(v)}`)
      : `(${type} = 'array' AND ${j} @> ${json([v])})`;
  };
  // A string holds a string; an array holds any member.
  const contains = (v: unknown): string =>
    typeof v === 'string' ? `(${like(`%${escapeLikePattern(v)}%`)} OR ${member(v)})` : member(v);

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
      const { source, caseInsensitive } = readPattern(value as string | RegExp);
      const match = `(${type} = 'string' AND ${text} ~${caseInsensitive ? '*' : ''} ${nextParam(state, postgresSource(source))})`;
      return rule.operator === Operator.matches ? match : not(match);
    }
  }
  const symbol = orderedSql(rule.operator, 'field')?.symbol;
  if (symbol) return `(${type} = jsonb_typeof(${json(value)}) AND ${j} ${symbol} ${json(value)})`;
  throw new Error(`Operator '${rule.operator}' is not supported on a Json value in SQL`);
};
