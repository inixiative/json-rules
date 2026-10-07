import { DateOperator, Operator } from '../operator';
import { nextParam } from './params';
import type { BuilderState } from './types';
import { isMissing, type ResolvedRhs } from './valueSource';

// A field against an operand, for the field and date compilers alike. A negated comparison is
// the complement of its positive form, as check() evaluates it: SQL's three-valued logic makes
// it NULL — never true — for a NULL field, so every negation carries the NULL rows explicitly.
// An operand that reads nothing matches no row, and a negation keeps the NULL fields only.

export const ORDERED_SQL: Partial<Record<string, { symbol: string; negated?: true }>> = {
  [Operator.lessThan]: { symbol: '<' },
  [Operator.lessThanEquals]: { symbol: '<=' },
  [Operator.greaterThan]: { symbol: '>' },
  [Operator.greaterThanEquals]: { symbol: '>=' },
  [DateOperator.before]: { symbol: '<' },
  [DateOperator.after]: { symbol: '>' },
  [DateOperator.onOrBefore]: { symbol: '<=' },
  [DateOperator.onOrAfter]: { symbol: '>=' },
  [DateOperator.notBefore]: { symbol: '>=', negated: true },
  [DateOperator.notAfter]: { symbol: '<=', negated: true },
};

export const operandSql = (rhs: ResolvedRhs, state: BuilderState): string =>
  rhs.type === 'column' ? rhs.sql : nextParam(state, rhs.value);

export const orNull = (field: string, expr: string): string => `(${expr} OR ${field} IS NULL)`;

/** No operand to compare against: no row, or the NULL fields for a negation. */
export const noOperandSql = (field: string, negated: boolean, nullable = true): string =>
  negated && nullable ? `${field} IS NULL` : 'FALSE';

/** `field <symbol> operand`. */
export const compareSql = (
  field: string,
  symbol: string,
  rhs: ResolvedRhs,
  negated: boolean,
  state: BuilderState,
): string => {
  if (isMissing(rhs)) return noOperandSql(field, negated);
  const comparison = `${field} ${symbol} ${operandSql(rhs, state)}`;
  return negated ? orNull(field, comparison) : comparison;
};

/** `field BETWEEN a AND b`. Ends known now arrive sorted; ends read per row sort in SQL
 *  (SYMMETRIC), and a per-row end that reads NULL matches nothing. */
export const rangeSql = (
  field: string,
  ends: [ResolvedRhs, ResolvedRhs] | null,
  negated: boolean,
  state: BuilderState,
  nullable = true,
): string => {
  if (!ends || ends.some(isMissing)) return noOperandSql(field, negated, nullable);
  const [a, b] = ends.map((end) => operandSql(end, state));
  const perRow = ends.some((end) => end.type === 'column');
  const symmetric = perRow ? 'SYMMETRIC ' : '';
  if (!negated) return `${field} BETWEEN ${symmetric}${a} AND ${b}`;
  const outside = `${field} NOT BETWEEN ${symmetric}${a} AND ${b}`;
  const guarded = perRow ? `(${outside} AND ${a} IS NOT NULL AND ${b} IS NOT NULL)` : outside;
  return nullable ? orNull(field, guarded) : guarded;
};
