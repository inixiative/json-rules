import { fieldlessArrayError, unknownOperator, windowUnsupported } from '../errors';
import { ruleShape } from '../fieldMap/shape';
import { fieldEntry } from '../fieldMap/walk';
import { ArrayOperator } from '../operator';
import type { ArrayRule } from '../types';
import { hasWindow } from '../window';
import { emptinessSql } from './field';
import { resolveField, resolveFieldSql } from './join';
import type { BuilderState } from './types';

export const buildArrayRule = (rule: ArrayRule, state: BuilderState): string => {
  if (hasWindow(rule)) throw windowUnsupported('toSql');
  if (!rule.field) {
    throw fieldlessArrayError('toSql');
  }
  const shape = ruleShape({ field: rule.field }, state.map, state.currentModel);
  if (
    shape === 'relation' ||
    fieldEntry(rule.field, state.map, state.currentModel)?.kind === 'object'
  )
    throw new Error(
      `Field '${rule.field}' is a relation — relation arrays are not supported in SQL; use toPrisma().`,
    );

  switch (rule.arrayOperator) {
    case ArrayOperator.empty:
    case ArrayOperator.notEmpty: {
      // A list column, or else a Json array — an array rule names one. A Json value that isn't an
      // array reads as empty, as an aggregate reads it (check() refuses it as malformed data).
      const field = resolveField(rule.field, state);
      const empty = rule.arrayOperator === ArrayOperator.empty;
      if (field.shape === 'list') return emptinessSql(rule.field, field, empty, state, false);
      const j = resolveFieldSql(rule.field, state, { jsonb: true });
      return `(CASE WHEN jsonb_typeof(${j}) = 'array' THEN jsonb_array_length(${j}) ${empty ? '=' : '>'} 0 ELSE ${empty ? 'TRUE' : 'FALSE'} END)`;
    }

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
      throw unknownOperator((rule as ArrayRule).arrayOperator, 'array');
  }
};
