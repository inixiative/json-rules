import { ArrayOperator } from '../operator';
import { fieldEntry } from '../toPrisma/mapWalk';
import type { ArrayRule } from '../types';
import { hasWindow } from '../window';
import { resolveFieldSql } from './join';
import type { BuilderState } from './types';

const WINDOW_UNSUPPORTED =
  'Windowing (orderBy/take/skip) is not supported by toSql(); evaluate with check().';

export const buildArrayRule = (rule: ArrayRule, state: BuilderState): string => {
  if (hasWindow(rule)) throw new Error(WINDOW_UNSUPPORTED);
  if (!rule.field) {
    throw new Error('toSql: ArrayRule.field is required (fieldless arrayOps are check-only)');
  }
  const entry = fieldEntry(rule.field, state.map, state.currentModel);
  if (entry?.kind === 'object')
    throw new Error(
      `Field '${rule.field}' is a relation — relation arrays are not supported in SQL; use toPrisma().`,
    );
  const isNative = entry?.kind === 'scalar' && entry?.isList === true;
  const field = resolveFieldSql(rule.field, state, { jsonb: !isNative });

  // Different length functions for JSONB vs native PostgreSQL arrays
  const lengthFn = isNative
    ? `array_length(${field}, 1)` // Native: TEXT[], INT[], etc.
    : `jsonb_array_length(${field})`; // JSONB arrays

  switch (rule.arrayOperator) {
    case ArrayOperator.empty:
      if (isNative) {
        // Native arrays: NULL or empty (array_length returns NULL for empty)
        return `(${field} IS NULL OR ${lengthFn} IS NULL)`;
      }
      return `(${field} IS NULL OR ${lengthFn} = 0)`;

    case ArrayOperator.notEmpty:
      if (isNative) {
        return `(${field} IS NOT NULL AND ${lengthFn} IS NOT NULL)`;
      }
      return `(${field} IS NOT NULL AND ${lengthFn} > 0)`;

    case ArrayOperator.all:
    case ArrayOperator.any:
    case ArrayOperator.none:
    case ArrayOperator.atLeast:
    case ArrayOperator.atMost:
    case ArrayOperator.exactly:
      throw new Error(
        `Array operator '${rule.arrayOperator}' with conditions is not supported in SQL. ` +
          'Use application-level filtering for complex array operations.',
      );

    default:
      throw new Error(`Unknown array operator: ${(rule as ArrayRule).arrayOperator}`);
  }
};
