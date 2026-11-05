import { isPlainObject } from 'lodash-es';
import { aggregateItems, aggregateValues, type EvalOptions, sumOrAverage } from '../check';
import { resolveDateConfig } from '../date';
import { DEFAULT_ZONE } from '../dateExpr';
import { resolveCaseInsensitive } from '../engineGlobals';
import { unknownValueAggregateMode, valueTakesNoComparison } from '../errors';
import { isValueAggregateMode } from '../operatorCatalog';
import type { AggregateValue } from '../types';
import { readValueSource } from '../valueSource';
import { coerceAggregateValue } from './coerceAggregateValue';
import { distinctValues } from './distinctValues';
import { namesComparison } from './namesComparison';

type Ordered = number | bigint | Date;

// min / max order numbers and dates; a string orders only once `coerceType` has read it.
const orderedValue = (raw: unknown, loc: string): Ordered => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'bigint') return raw;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  throw new Error(`${loc} must be a finite number or a valid date for min / max`);
};

const orderClass = (value: Ordered): string => (value instanceof Date ? 'date' : 'number');

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
 *  `count`, `sum` (0 over none), `avg`, `min`, `max` (numbers and dates; null over none),
 *  `distinct` (the values without repeats, first seen first; NULLs skipped as every mode skips
 *  them; `[]` over none). `distinct` / `min` / `max` read each value through `coerceType`;
 *  `distinct` folds case under `caseInsensitive` (default `string.caseInsensitive`). */
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
  // Only a DateTime coercion reads the zone, as in check().
  const zone =
    node.coerceType === 'DateTime'
      ? resolveDateConfig(opts, (source) => readValueSource(source, opts.scopes, opts.bindings))
          .timeZone
      : DEFAULT_ZONE;
  const coerce = coerceAggregateValue(node.coerceType, zone);
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
    case 'distinct':
      return distinctValues(
        aggregateValues(items, node.field, itemField, coerce),
        resolveCaseInsensitive(node.caseInsensitive),
      );
    default:
      return extreme(
        aggregateValues(items, node.field, itemField, (raw, loc) => orderedValue(coerce(raw), loc)),
        mode,
        node.field,
      );
  }
};
