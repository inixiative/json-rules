import { fieldEntry } from '../toPrisma/mapWalk';
import type { AggregateRule, Rule } from '../types';
import { hasWindow } from '../window';
import { buildFieldRule } from './field';
import { resolveFieldSql } from './join';
import { jsonKey } from './quoting';
import type { BuilderState } from './types';

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
  // An aggregate compares like a field whose value the subquery computes.
  return buildFieldRule(rule as unknown as Rule, state, subquery);
};

const buildAggregateSubquery = (rule: AggregateRule, state: BuilderState): string => {
  const { mode, field: itemField } = rule.aggregate;
  // check() reads the sum and the average of nothing as 0.
  const fn = mode === 'sum' ? 'SUM' : 'AVG';

  const entry = fieldEntry(rule.field, state.map, state.currentModel);

  if (entry?.kind === 'object') {
    throw new Error(
      `Field '${rule.field}' is a relation — toSql() cannot aggregate relation lists. Use toPrisma() instead.`,
    );
  }

  if (itemField?.includes('.')) {
    throw new Error(
      `aggregate.field '${itemField}' contains a nested path — toSql() only supports flat field names. Use check() for nested paths.`,
    );
  }

  const isNative = entry?.kind === 'scalar' && entry?.isList === true;
  // Aggregate functions read the array as JSONB (a native array as itself), never as text.
  const field = resolveFieldSql(rule.field, state, { jsonb: !isNative });

  if (isNative) {
    if (itemField) {
      throw new Error(
        `aggregate.field is not supported for native array types. Use a JSONB column for object arrays.`,
      );
    }
    const agg = `COALESCE(${fn}(elem), 0)`;
    return `(SELECT ${agg} FROM unnest(${field}) AS elem)`;
  }

  if (itemField) {
    // JSONB object array
    const extract = `(elem->>${jsonKey(itemField)})::numeric`;
    const agg = `COALESCE(${fn}(${extract}), 0)`;
    return `(SELECT ${agg} FROM jsonb_array_elements(${field}) AS elem)`;
  }

  // JSONB primitive array
  const extract = `elem::numeric`;
  const agg = `COALESCE(${fn}(${extract}), 0)`;
  return `(SELECT ${agg} FROM jsonb_array_elements_text(${field}) AS elem)`;
};
