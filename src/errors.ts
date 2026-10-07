import { resolveFuzzy } from './engineGlobals';
import type { FuzzyConfig } from './fuzzy';
import { CONTAINS_OPERATORS, ORDERED_OPERATORS, RANGE_OPERATORS } from './operatorCatalog';
// Error texts every rail raises the same way.

/** A rule kind a compiler compiles only with a field (check() also takes a root array). */
export const fieldlessArrayError = (target: 'toSql' | 'toPrisma'): Error =>
  new Error(`${target}: ArrayRule.field is required (fieldless arrayOps are check-only)`);

/** A counting or element-wise array operator with no condition. */
export const conditionRequired = (operator: string): Error =>
  new Error(`${operator} requires a condition to check against array elements`);

/** Comparing a to-one relation as a value. */
export const relationNotValue = (field: string): Error =>
  new Error(
    `'${field}' is a relation: it exists or not; compare its fields with '${field}.<field>'.`,
  );

/** A to-many relation compared as a value: it is rows, which an array operator reads. */
export const relationsNotValue = (field: string): Error =>
  new Error(
    `'${field}' is a list of rows: compare it with an arrayOperator (any / all / none / empty / atLeast …).`,
  );

/** Fuzzy matching (a rule's `fuzzy`, or the engine-global default) on a compiler: it has no
 *  compiled form, so the compilers refuse what check() would match fuzzily. */
export const fuzzyNotCompiled = (rule: { fuzzy?: unknown; operator: string }): Error | null =>
  CONTAINS_OPERATORS.includes(rule.operator) &&
  resolveFuzzy(rule.fuzzy as boolean | FuzzyConfig | undefined)
    ? new Error('Fuzzy matching has no compiled form — evaluate it in memory with check().')
    : null;

/** An ordered comparison or a range against a value that doesn't order — a boolean, a list or an
 *  object: check() matches nothing, and the databases order it by type (Prisma panics). */
export const unorderedOperand = (operator: string, value: unknown): Error | null => {
  if (!ORDERED_OPERATORS.includes(operator) && !RANGE_OPERATORS.includes(operator)) return null;
  const ends = RANGE_OPERATORS.includes(operator) && Array.isArray(value) ? value : [value];
  return ends.some(
    (end) =>
      typeof end === 'boolean' ||
      (typeof end === 'object' && end !== null && !(end instanceof Date)),
  )
    ? new Error(
        `'${operator}' orders numbers, strings and dates; it can't compare ${JSON.stringify(value)}`,
      )
    : null;
};

/** A node that is not exactly one kind of condition. */
export const ambiguousCondition = (): Error =>
  new Error(
    'A condition is exactly one of: a field, date, array or aggregate rule, all, any, or if/then[/else]',
  );

/** A window (filter / orderBy / take / skip) a compiler has no form for. */
export const windowUnsupported = (target: 'toSql' | 'toPrisma'): Error =>
  new Error(
    `Windowing (filter/orderBy/take/skip) is not supported by ${target}() for this rule; evaluate with check()${target === 'toPrisma' ? ' — toPrisma compiles a filter alone and an extremal take: 1' : ''}.`,
  );
