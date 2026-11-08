import { unknownAggregateMode, windowUnsupported } from '../errors';
import { ruleShape } from '../fieldMap/shape';
import { fieldEntry } from '../fieldMap/walk';
import { AGGREGATE_MODES } from '../operatorCatalog';
import type { AggregateRule, Rule } from '../types';
import { hasWindow } from '../window';
import { buildFieldRule } from './field';
import { resolveFieldSql } from './join';
import { jsonKey } from './quoting';
import type { BuilderState } from './types';

export const buildAggregateRule = (rule: AggregateRule, state: BuilderState): string => {
  if (hasWindow(rule)) throw windowUnsupported('toSql');
  if (rule.condition) {
    throw new Error(
      `Aggregate condition filtering is not yet supported by toSql(). ` +
        `Use check() for in-memory evaluation or toPrisma() for database queries.`,
    );
  }

  const subquery = buildAggregateSubquery(rule, state);
  // An aggregate compares like a field whose value the subquery computes; an average can be NULL.
  // Its coerceType parsed the items, which `::numeric` already does; the number compares as is.
  const { coerceType: _parsed, ...comparison } = rule;
  return buildFieldRule(
    comparison as unknown as Rule,
    state,
    subquery,
    rule.aggregate.mode === 'avg',
  );
};

const buildAggregateSubquery = (rule: AggregateRule, state: BuilderState): string => {
  const { mode, field: itemField } = rule.aggregate;
  if (!AGGREGATE_MODES.includes(mode)) throw unknownAggregateMode(mode);
  const fn = mode === 'sum' ? 'SUM' : 'AVG';
  // The sum of nothing is 0, as check() reads it; the average of nothing stays NULL (FEAT-007).
  const total = (expr: string) =>
    mode === 'sum' ? `COALESCE(${fn}(${expr}), 0)` : `${fn}(${expr})`;

  const shape = ruleShape({ field: rule.field }, state.map, state.currentModel);

  if (
    shape === 'relation' ||
    fieldEntry(rule.field, state.map, state.currentModel)?.kind === 'object'
  ) {
    throw new Error(
      `Field '${rule.field}' is a relation — toSql() cannot aggregate relation lists. Use toPrisma() instead.`,
    );
  }

  if (itemField?.includes('.')) {
    throw new Error(
      `aggregate.field '${itemField}' contains a nested path — toSql() only supports flat field names. Use check() for nested paths.`,
    );
  }

  const isNative = shape === 'list';
  // Aggregate functions read the array as JSONB (a native array as itself), never as text. A
  // Json value that is not an array — JSON null among them — has no elements, as check() reads
  // a null array.
  const read = resolveFieldSql(rule.field, state, { jsonb: !isNative });
  const field = isNative ? read : `(CASE WHEN jsonb_typeof(${read}) = 'array' THEN ${read} END)`;

  if (isNative) {
    if (itemField) {
      throw new Error(
        `aggregate.field is not supported for native array types. Use a JSONB column for object arrays.`,
      );
    }
    const agg = total('elem');
    return `(SELECT ${agg} FROM unnest(${field}) AS elem)`;
  }

  if (itemField) {
    // JSONB object array
    const extract = `(elem->>${jsonKey(itemField)})::numeric`;
    const agg = total(extract);
    return `(SELECT ${agg} FROM jsonb_array_elements(${field}) AS elem)`;
  }

  // JSONB primitive array
  const extract = `elem::numeric`;
  const agg = total(extract);
  return `(SELECT ${agg} FROM jsonb_array_elements_text(${field}) AS elem)`;
};
