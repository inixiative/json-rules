import { get } from 'lodash';
import { escapeIdentifier } from 'pg';
import { Operator } from '../operator';
import type { AggregateRule } from '../types';
import { nextParam } from './params';
import { quoteField, quoteFieldAsJsonb } from './quoting';
import type { BuilderState } from './types';

export const buildAggregateRule = (rule: AggregateRule, state: BuilderState): string => {
  const subquery = buildAggregateSubquery(rule, state);
  return buildAggregateComparison(subquery, rule, state);
};

const buildAggregateSubquery = (rule: AggregateRule, state: BuilderState): string => {
  // Use JSONB-preserving field reference — aggregate functions need JSONB input, not text
  const field = quoteFieldAsJsonb(rule.field);
  const { mode, field: itemField } = rule.aggregate;
  const fn = mode === 'sum' ? 'SUM' : 'AVG';

  const fieldEntry = state.map?.[state.currentModel ?? '']?.fields[rule.field];

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

type ResolvedRhs = { type: 'value'; value: unknown } | { type: 'column'; sql: string };

const resolveRhs = (rule: AggregateRule, state: BuilderState): ResolvedRhs => {
  if (rule.value !== undefined) return { type: 'value', value: rule.value };

  if (rule.path) {
    if (rule.path.startsWith('$.')) {
      const refField = rule.path.substring(2);
      const sql = state.currentAlias
        ? `${escapeIdentifier(state.currentAlias)}.${escapeIdentifier(refField)}`
        : quoteField(refField);
      return { type: 'column', sql };
    }
    if (!state.context) {
      throw new Error(
        `BuilderState.context is required to resolve path '${rule.path}'. Pass context in options.`,
      );
    }
    return { type: 'value', value: get(state.context, rule.path) };
  }

  throw new Error('Aggregate rule requires value or path');
};

const buildAggregateComparison = (
  lhs: string,
  rule: AggregateRule,
  state: BuilderState,
): string => {
  const rhs = resolveRhs(rule, state);
  const rhsVal = rhs.type === 'value' ? rhs.value : undefined;
  const rhsCol = rhs.type === 'column' ? rhs.sql : undefined;

  switch (rule.operator) {
    case Operator.equals:
      if (rhsCol) return `${lhs} = ${rhsCol}`;
      if (rhsVal === null) return `${lhs} IS NULL`;
      return `${lhs} = ${nextParam(state, rhsVal)}`;
    case Operator.notEquals:
      if (rhsCol) return `${lhs} <> ${rhsCol}`;
      if (rhsVal === null) return `${lhs} IS NOT NULL`;
      return `${lhs} <> ${nextParam(state, rhsVal)}`;
    case Operator.lessThan:
      if (rhsCol) return `${lhs} < ${rhsCol}`;
      return `${lhs} < ${nextParam(state, rhsVal)}`;
    case Operator.lessThanEquals:
      if (rhsCol) return `${lhs} <= ${rhsCol}`;
      return `${lhs} <= ${nextParam(state, rhsVal)}`;
    case Operator.greaterThan:
      if (rhsCol) return `${lhs} > ${rhsCol}`;
      return `${lhs} > ${nextParam(state, rhsVal)}`;
    case Operator.greaterThanEquals:
      if (rhsCol) return `${lhs} >= ${rhsCol}`;
      return `${lhs} >= ${nextParam(state, rhsVal)}`;
    case Operator.between: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) throw new Error('between requires two values');
      const [min, max] = (v[0] as number) <= (v[1] as number) ? v : [v[1], v[0]];
      return `${lhs} BETWEEN ${nextParam(state, min)} AND ${nextParam(state, max)}`;
    }
    case Operator.notBetween: {
      const v = rhsVal as unknown[];
      if (!Array.isArray(v) || v.length !== 2) throw new Error('notBetween requires two values');
      const [min, max] = (v[0] as number) <= (v[1] as number) ? v : [v[1], v[0]];
      return `${lhs} NOT BETWEEN ${nextParam(state, min)} AND ${nextParam(state, max)}`;
    }
    default:
      throw new Error(`Operator '${rule.operator}' is not supported for aggregate rules`);
  }
};
