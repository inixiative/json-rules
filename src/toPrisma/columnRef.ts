import { enumColumnProblem } from '../columnEnum';
import { resolveCaseInsensitive } from '../engineGlobals';
import { isJsonEntry, isRelationEntry } from '../fieldMap/entry';
import type { FieldMap, FieldMapEntry } from '../fieldMap/types';
import { walkFieldPath } from '../fieldMap/walk';
import { Operator } from '../operator';
import { parseScopeRef } from '../scope';
import type { Rule } from '../types';
import { emit } from './sentinels';

/**
 * A compared column on the Prisma rail: `{ __field }` stands for `<delegate>.fields.<field>`,
 * which `executePrismaPlan` puts in place — a where read without it carries the sentinel, which
 * Prisma rejects.
 */
export type FieldRef = { __field: { model: string; field: string } };

/** The Prisma filter key each supported operator compares a column with. Prisma's field
 *  references take no `not` and no `in`; its `contains` / `startsWith` / `endsWith` read the
 *  column as a LIKE pattern, so a % or _ in it is a wildcard — not check()'s substring. */
const COLUMN_OPERATORS: Record<string, string> = {
  [Operator.equals]: 'equals',
  [Operator.notEquals]: 'equals',
  [Operator.lessThan]: 'lt',
  [Operator.lessThanEquals]: 'lte',
  [Operator.greaterThan]: 'gt',
  [Operator.greaterThanEquals]: 'gte',
};

/** A supported column comparison: the filter key, the reference, and each column's entry and
 *  path at the visit. */
export type ColumnCompare = {
  key: string;
  ref: FieldRef;
  field: FieldMapEntry;
  column: FieldMapEntry;
  columnPath: string;
};

// A column of the visit's own model: one segment, a scalar or enum, not a list or Json.
const ownColumn = (path: string, map: FieldMap, model: string): FieldMapEntry | string => {
  const walk = walkFieldPath(path, map, model);
  if (walk.kind !== 'direct' || walk.hops.length > 0)
    return `'${path}' is not a column of ${model} (a relation hop or an undeclared path)`;
  const { entry } = walk;
  if (isRelationEntry(entry)) return `'${path}' is a relation`;
  if (isJsonEntry(entry)) return `'${path}' is a Json column`;
  if (entry.isList) return `'${path}' is a list column`;
  return entry;
};

/**
 * How a field rule whose value is a `path` compiles on the Prisma rail, or why it can't. Prisma
 * compares two columns only through a field reference: both on the same model at the same visit
 * (a bare path at the root, `$.` in a relation filter), of exactly the same type, with an
 * equality or ordered operator; no offset (Prisma has no arithmetic), and text compared
 * case-sensitively (an insensitive one compiles to ILIKE, where the column's % and _ are wildcards).
 */
export const columnCompare = (
  rule: Pick<Rule, 'field' | 'operator' | 'path' | 'offset' | 'caseInsensitive'>,
  map: FieldMap | undefined,
  model: string | undefined,
  nested: boolean,
  inStep = false,
): ColumnCompare | { problem: string } => {
  const ref = rule.path as string;
  if (inStep)
    return {
      problem:
        'inside a counting step (a count or relation aggregate) a groupBy carries no column reference',
    };
  const scoped = parseScopeRef(ref);
  if (scoped && scoped.depth > 1)
    return { problem: `'${ref}' reads an enclosing scope, which a Prisma filter can't reach` };
  if (!scoped && nested)
    return {
      problem: `'${ref}' reads the root row, which a Prisma relation filter can't reach`,
    };
  if (!map || !model) return { problem: 'comparing two columns needs the map and model' };
  const op = COLUMN_OPERATORS[rule.operator];
  if (!op) return { problem: `'${rule.operator}' takes no column reference in Prisma` };
  if (rule.offset !== undefined) return { problem: 'an offset is arithmetic, which Prisma lacks' };
  const field = ownColumn(rule.field, map, model);
  if (typeof field === 'string') return { problem: field };
  const columnPath = scoped ? scoped.path : ref;
  const column = ownColumn(columnPath, map, model);
  if (typeof column === 'string') return { problem: column };
  if (field.kind !== column.kind || field.type !== column.type)
    return {
      problem: `'${rule.field}' (${field.type}) and '${columnPath}' (${column.type}) are not the same type`,
    };
  const enumProblem = enumColumnProblem(field, column, rule.operator);
  if (enumProblem) return { problem: enumProblem };
  if (field.type === 'String' && resolveCaseInsensitive(rule.caseInsensitive))
    return { problem: 'a case-insensitive column comparison compiles to ILIKE' };
  return {
    key: op,
    ref: emit({ __field: { model, field: columnPath } }),
    field,
    column,
    columnPath,
  };
};

/** The message a column comparison Prisma can't compile throws with. */
export const columnCompareError = (ref: string, problem: string): Error =>
  new Error(
    `Path '${ref}' compares to a column, which the Prisma rail supports only between columns of the same model and type: ${problem}. Use toSql() or check().`,
  );

// The options objects of relation filters: a bare path there reads the root row, out of reach;
// and of a counting step's condition, which a groupBy compiles.
const NESTED = new WeakSet<object>();
const STEP = new WeakSet<object>();

/** Marks compile options as a relation filter's (a nested scope) — a counting step's when `step`,
 *  or when the scope it opens from is inside one. */
export const nestedScope = <O extends object>(options: O, from?: object, step = false): O => {
  NESTED.add(options);
  if (step || (from !== undefined && STEP.has(from))) STEP.add(options);
  return options;
};

export const isNestedScope = (options: object | undefined): boolean =>
  options !== undefined && NESTED.has(options);

export const isStepScope = (options: object | undefined): boolean =>
  options !== undefined && STEP.has(options);
