import { isRelationEntry } from '../fieldMap/entry';
import type { Lens, LensNarrowing } from '../lens/types';
import { AGGREGATE_MODE_CATALOG, FieldKind, ORDERED_VALUE_KINDS } from '../operatorCatalog';
import type { AggregateValue, ValueAggregateMode, ValueType } from '../types';
import { columnKind, needLens, resolveValuePath, rowPath } from './resolveValuePath';
import { isNumeric } from './unifyValueTypes';
import { refuse } from './valueTypeIssue';

// The list an aggregate reads: a to-many relation or a scalar list column.
const aggregateList = (lens: Lens | LensNarrowing, node: AggregateValue, path: string) => {
  const field = rowPath(node.field, `${path}.field`);
  const list = resolveValuePath(lens, field, `${path}.field`);
  if (list.viaList || list.entry.isList !== true)
    refuse(
      `${path}.field`,
      'aggregate_needs_list',
      `'${node.field}' is not a list; an aggregate reads a list`,
    );
  return { field, list };
};

// The kind of the values an aggregate reads: `aggregate.field` on each related row, or each
// value of a scalar list.
const elementKind = (
  lens: Lens | LensNarrowing,
  node: AggregateValue,
  path: string,
): FieldKind | null => {
  const { field, list } = aggregateList(lens, node, path);
  const itemField = node.aggregate.field;
  if (!isRelationEntry(list.entry)) {
    if (itemField !== undefined)
      refuse(
        `${path}.aggregate.field`,
        'invalid_aggregate_field',
        `'${node.field}' holds values, not rows`,
      );
    return columnKind(list);
  }
  if (itemField === undefined)
    return refuse(
      `${path}.aggregate.field`,
      'aggregate_field_required',
      `${node.aggregate.mode} over rows names the field it reads`,
    );
  const item = resolveValuePath(lens, `${field}.${itemField}`, `${path}.aggregate.field`);
  if (isRelationEntry(item.entry) || item.entry.isList)
    refuse(
      `${path}.aggregate.field`,
      'invalid_aggregate_field',
      `'${itemField}' is not one value per row`,
    );
  return columnKind(item);
};

/** An aggregate value's type: `count` an `Int`; `sum` its column's numeric kind, never null;
 *  `avg` a `Float` (`Decimal` stays `Decimal`), null over no rows; `min` / `max` their column's
 *  kind, nullable. */
export const aggregateType = (
  lens: Lens | LensNarrowing | undefined,
  node: AggregateValue,
  path: string,
): ValueType => {
  const mode = node.aggregate.mode as ValueAggregateMode;
  if (AGGREGATE_MODE_CATALOG[mode].result === 'count') {
    // A count is a number whatever it counts; the list it counts is checked when there is a lens.
    if (lens) aggregateList(lens, node, path);
    return { kind: FieldKind.Int, isList: false, nullable: false };
  }
  const kind = elementKind(needLens(lens, `${mode} over '${node.field}'`), node, path);
  const at = `${path}.aggregate.field`;
  if (mode === 'sum' || mode === 'avg') {
    if (!isNumeric(kind))
      refuse(
        at,
        'aggregate_kind_mismatch',
        `${mode} adds numbers, not ${kind ?? 'untyped'} values`,
      );
    const sumKind = mode === 'sum' || kind === FieldKind.Decimal ? kind : FieldKind.Float;
    // sum over no rows is 0; avg over none is null.
    return { kind: sumKind, isList: false, nullable: mode === 'avg' };
  }
  if (kind === null || !ORDERED_VALUE_KINDS.includes(kind))
    refuse(
      at,
      'aggregate_kind_mismatch',
      `${mode} orders numbers, strings and dates, not ${kind ?? 'untyped'} values`,
    );
  return { kind, isList: false, nullable: true };
};
