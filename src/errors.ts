import { resolveFuzzy } from './engineGlobals';
import type { MapHop } from './fieldMap/walk';
import type { FuzzyConfig } from './fuzzy';
import {
  AGGREGATE_MODES,
  CONTAINS_OPERATORS,
  ORDERED_OPERATORS,
  RANGE_OPERATORS,
} from './operatorCatalog';
// Error texts every rail raises the same way.

/** A rule kind a compiler compiles only with a field (check() also takes a root array). */
export const fieldlessArrayError = (target: 'toSql' | 'toPrisma'): Error =>
  new Error(`${target}: ArrayRule.field is required (fieldless arrayOps are check-only)`);

/** An operator the catalog doesn't list in its family. */
export const unknownOperator = (operator: unknown, family: string): Error =>
  new Error(`Unknown ${family} operator: ${String(operator)}`);

/** A counting array operator with no count. */
export const countRequired = (operator: string): Error => new Error(`${operator} requires a count`);

/** A window date operator against a single point instead of a range expression. */
export const rangeExprRequired = (operator: string): Error =>
  new Error(
    `${operator} requires a range date expression (a period or rolling window), not a single point`,
  );

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

/** An aggregate mode outside AGGREGATE_MODES. */
export const unknownAggregateMode = (mode: unknown): Error =>
  new Error(`aggregate.mode must be one of ${AGGREGATE_MODES.join(' / ')}, not '${String(mode)}'`);

/** A node that is not exactly one kind of condition. */
export const ambiguousCondition = (): Error =>
  new Error(
    'A condition is exactly one of: a field, date, array or aggregate rule, all, any, or if/then[/else]',
  );

/** A rule a compiler can't express as check() reads it: refused, never compiled to something
 *  else. `why` says what the target would do instead. */
export const noCompiledForm = (target: 'toSql' | 'toPrisma', what: string, why?: string): Error =>
  new Error(
    `${what} has no ${target === 'toSql' ? 'SQL' : 'Prisma'} form${why ? ` (${why})` : ''}; use ${target === 'toSql' ? 'check()' : 'toSql() or check()'}.`,
  );

/** A window (filter / orderBy / take / skip) a compiler has no form for. */
export const windowUnsupported = (target: 'toSql' | 'toPrisma'): Error =>
  new Error(
    `Windowing (filter/orderBy/take/skip) is not supported by ${target}() for this rule; evaluate with check()${target === 'toPrisma' ? ' — toPrisma compiles a filter alone and an extremal take: 1' : ''}.`,
  );

/** A to-many relation inside a plain field path: which child it reads is undefined. */
export const toManyHopError = (field: string, hop: MapHop): Error =>
  new Error(
    `'${field}' reads through the to-many relation '${hop.prefix}'; compare its rows with an arrayOperator rule on '${hop.prefix}'.`,
  );

/** The error for a path that continues past a non-Json column. */
export const pastScalarError = (field: string, column: string): Error =>
  new Error(`'${field}' continues past '${column}', which is not a Json column`);

/** A caller's input missing for a compile — the clock, a bind's value — not the rule's shape. */
export class UsageError extends Error {}
