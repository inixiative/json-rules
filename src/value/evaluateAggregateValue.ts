import { isPlainObject } from 'lodash-es';
import { aggregateItems, aggregateValues, type EvalOptions, sumOrAverage } from '../check';
import { unknownValueAggregateMode, valueTakesNoComparison } from '../errors';
import { isValueAggregateMode } from '../operatorCatalog';
import type { AggregateValue } from '../types';
import { namesComparison } from './namesComparison';

type Ordered = number | bigint | string | Date;

const orderedValue = (raw: unknown, loc: string): Ordered => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint' || typeof raw === 'string') return raw;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  throw new Error(`${loc} must be a finite number, a string or a valid date for min / max`);
};

const orderClass = (value: Ordered): string =>
  value instanceof Date ? 'date' : typeof value === 'bigint' ? 'number' : typeof value;

// The least or greatest of one kind of value; null over none.
const extreme = (values: Ordered[], mode: 'min' | 'max', field: string): Ordered | null => {
  if (values.length === 0) return null;
  const kinds = new Set(values.map(orderClass));
  if (kinds.size > 1)
    throw new Error(`${field} ${mode} orders one kind of value, not ${[...kinds].join(' and ')}`);
  const key = (value: Ordered) => (value instanceof Date ? value.getTime() : value);
  return values.reduce((best, value) =>
    (mode === 'max' ? key(value) > key(best) : key(value) < key(best)) ? value : best,
  );
};

/** The value an aggregate computes over its relation's rows, through its window and condition:
 *  `count`, `sum` (0 over none), `avg`, `min`, `max` (null over none). */
export const evaluateAggregateValue = (
  node: AggregateValue,
  opts: EvalOptions,
  path: string,
): unknown => {
  if (namesComparison(node)) throw valueTakesNoComparison(path);
  if (!isPlainObject(node.aggregate)) throw new Error(`${path}.aggregate must be an object`);
  const { mode, field: itemField } = node.aggregate;
  if (!isValueAggregateMode(mode)) throw unknownValueAggregateMode(mode);
  if (typeof node.field !== 'string' || node.field === '')
    throw new Error(`${path}.field: an aggregate value reads a list field`);
  const items = aggregateItems(node, opts);
  switch (mode) {
    case 'count':
      // COUNT(*) over the items, or COUNT(field) — the items whose field has a value.
      return itemField === undefined
        ? items.length
        : aggregateValues(items, node.field, itemField, () => true).length;
    case 'sum':
      return sumOrAverage(mode, items, node.field, itemField);
    case 'avg':
      // No values have no average: null, as SQL's AVG over none.
      return aggregateValues(items, node.field, itemField, () => true).length === 0
        ? null
        : sumOrAverage(mode, items, node.field, itemField);
    default:
      return extreme(aggregateValues(items, node.field, itemField, orderedValue), mode, node.field);
  }
};
