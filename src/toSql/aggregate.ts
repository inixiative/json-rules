import { orderPair } from '../number';
import { Operator } from '../operator';
import { fieldOf } from '../own';
import type { AggregateRule } from '../types';
import { hasWindow } from '../window';
import { compareSql, ORDERED_SQL } from './compare';
import { nextParam } from './params';
import { quoteField, quoteFieldAsJsonb } from './quoting';
import type { BuilderState } from './types';
import { resolveSource } from './valueSource';

export const buildAggregateRule = (rule: AggregateRule, state: BuilderState): string => {
  if (hasWindow(rule))
    throw new Error(
      'Windowing (orderBy/take/skip) is not supported by toSql(); evaluate with check().',
    );
  if (rule.condition) {
    throw new Error(
      `Aggregate condition filtering is not yet supported by toSql(). ` +
        `Use check() for in-memory evaluation or toPrisma() for database queries.`,
    );
  }

  const subquery = buildAggregateSubquery(rule, state);
  return buildAggregateComparison(subquery, rule, state);
};

const buildAggregateSubquery = (rule: AggregateRule, state: BuilderState): string => {
  // Use JSONB-preserving field reference — aggregate functions need JSONB input, not text
  const field = quoteFieldAsJsonb(rule.field);
  const { mode, field: itemField } = rule.aggregate;
  const fn = mode === 'sum' ? 'SUM' : 'AVG';

  const fieldEntry = fieldOf(state.map, state.currentModel ?? '', rule.field);

  if (fieldEntry?.kind === 'object') {
    throw new Error(
      `Field '${rule.field}' is a relation — toSql() cannot aggregate relation lists. Use toPrisma() instead.`,
    );
  }

  if (itemField?.includes('.')) {
    throw new Error(
      `aggregate.field '${itemField}' contains a nested path — toSql() only supports flat field names. Use check() for nested paths.`,
    );
  }

  const isNative = fieldEntry?.kind === 'scalar' && fieldEntry?.isList === true;

  if (isNative) {
    if (itemField) {
      throw new Error(
        `aggregate.field is not supported for native array types. Use a JSONB column for object arrays.`,
      );
    }
    const agg = fn === 'SUM' ? `COALESCE(SUM(elem), 0)` : `AVG(elem)`;
    return `(SELECT ${agg} FROM unnest(${field}) AS elem)`;
  }

  if (itemField) {
    // JSONB object array
    const extract = `(elem->>'${itemField}')::numeric`;
    const agg = fn === 'SUM' ? `COALESCE(SUM(${extract}), 0)` : `AVG(${extract})`;
    return `(SELECT ${agg} FROM jsonb_array_elements(${field}) AS elem)`;
  }

  // JSONB primitive array
  const extract = `elem::numeric`;
  const agg = fn === 'SUM' ? `COALESCE(SUM(${extract}), 0)` : `AVG(${extract})`;
  return `(SELECT ${agg} FROM jsonb_array_elements_text(${field}) AS elem)`;
};

const buildAggregateComparison = (
  lhs: string,
  rule: AggregateRule,
  state: BuilderState,
): string => {
  const rhs = resolveSource(rule, state);
  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  const ordered = ORDERED_SQL[rule.operator];
  if (ordered) return compareSql(lhs, ordered.symbol, rhs, false, state);

  switch (rule.operator) {
    case Operator.equals:
      if (rhsCol) return `${lhs} = ${rhsCol}`;
      if (rhsVal === null) return `${lhs} IS NULL`;
      return `${lhs} = ${nextParam(state, rhsVal)}`;
    case Operator.notEquals:
      if (rhsCol) return `${lhs} <> ${rhsCol}`;
      if (rhsVal === null) return `${lhs} IS NOT NULL`;
      return `${lhs} <> ${nextParam(state, rhsVal)}`;
    case Operator.between: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) throw new Error('between requires two values');
      const [min, max] = orderPair(v);
      return `${lhs} BETWEEN ${nextParam(state, min)} AND ${nextParam(state, max)}`;
    }
    case Operator.notBetween: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) throw new Error('notBetween requires two values');
      const [min, max] = orderPair(v);
      return `${lhs} NOT BETWEEN ${nextParam(state, min)} AND ${nextParam(state, max)}`;
    }
    default:
      throw new Error(`Operator '${rule.operator}' is not supported for aggregate rules`);
  }
};
