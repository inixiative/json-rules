import {
  engineGlobals,
  type PrismaProvider,
  resolveCaseInsensitive,
  supportsQueryMode,
} from '../engineGlobals';
import { hasNoOperand } from '../field';
import { orderPair, splitNull } from '../number';
import { Operator } from '../operator';
import {
  NEGATED_COMPARISON_OPERATORS,
  NEGATED_RANGE_OPERATORS,
  NEGATED_SINGLE_VALUE_OPERATORS,
  NO_VALUE_OPERATORS,
} from '../operatorCatalog';
import type { Rule } from '../types';
import { orWhere } from './logical';
import {
  acceptsEmptyString,
  compileFieldLiteral,
  fieldEntry,
  optionalToOneHops,
  pastScalarError,
  walkFieldPath,
  walkWith,
} from './mapWalk';
import { offsetNumber } from './offset';
import type { BuildOptions, FieldMap, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';
import { dateConfigOf, readSource } from './valueSource';

/**
 * Known nullable per the field map. Unknown (no map, no `isRequired`) reads as
 * required: an `equals: null` arm on a NOT NULL column is a Prisma validation
 * error at runtime, so the map is the only authority that can license one.
 */
const isNullableColumn = (rule: Pick<Rule, 'field'>, options?: BuildOptions): boolean =>
  fieldEntry(rule.field, options?.map as FieldMap | undefined, options?.model)?.isRequired ===
  false;

/**
 * The arms that make a negation match the rows where the path is ABSENT — what check()
 * sees as `undefined`/`null`. Two kinds, both licensed by the field map: the leaf column
 * NULL (`isRequired: false` on the column), and each optional to-one hop NULL
 * (`{ hop: { is: null } }` — Prisma's `{ rel: { col: { equals: null } } }` requires the
 * relation to exist, so a member with no relation would otherwise fall out of every
 * negation while the in-memory rail keeps them). Empty when nothing is licensed.
 */
const hopArms = (rule: Pick<Rule, 'field'>, options?: BuildOptions): PrismaWhere[] =>
  options?.map && options?.model
    ? optionalToOneHops(rule.field, options.map as FieldMap, options.model).map((hop) =>
        buildNestedFilter(hop, { is: null }),
      )
    : [];

export const absentArms = (rule: Pick<Rule, 'field'>, options?: BuildOptions): PrismaWhere[] => [
  ...(isNullableColumn(rule, options)
    ? [buildMapAwareFilter(rule.field, { equals: null }, options)]
    : []),
  ...hopArms(rule, options),
];

/**
 * The complement of a BOUNDED range, which Prisma can only express at the WHERE level.
 *
 * There is no field-level negation of a two-sided filter: Prisma distributes `not` over the keys
 * of the nested filter, so `{ col: { not: { gte: a, lte: b } } }` becomes
 * `NOT(col >= a) AND NOT(col <= b)` — unsatisfiable for any window, and it fails silently: the
 * query validates, runs, and returns nothing. `{ NOT: { col: { gte: a, lte: b } } }` negates the
 * whole clause, which is what a complement means, and matches what `toSql` has always emitted
 * (`NOT BETWEEN`). Same WHERE-level hoist the emptiness operators need above, for the same class
 * of reason.
 *
 * These carry their own `equals: null` arm below, so they are deliberately not in NEGATED_SINGLE_VALUE_OPERATORS.
 */

export const buildFieldRule = (rule: Rule, options?: BuildOptions): PrismaWhere => {
  const at = (filter: unknown) => buildMapAwareFilter(rule.field, filter, options);

  // isEmpty/notEmpty need OR/AND at the WHERE level (not field-filter level)
  // because Prisma 6.x rejects mixed null/string in `in`/`notIn` for nullable fields.
  const arms = absentArms(rule, options);

  if (rule.operator === Operator.isEmpty) {
    // isEmpty carries the leaf null arm unconditionally (it IS the operator); the optional hops
    // ride beside it, then the ''-arm on String/Json columns.
    const nulls = [at({ equals: null }), ...hopArms(rule, options)];
    const empties = acceptsEmptyString(rule, options?.map as FieldMap | undefined, options?.model)
      ? [...nulls, at({ equals: '' })]
      : nulls;
    return empties.length === 1 ? empties[0] : { OR: empties };
  }
  if (rule.operator === Operator.notExists && arms.length) {
    return orWhere(arms);
  }
  if (rule.operator === Operator.notEmpty) {
    const notNull = at({ not: null });
    if (!acceptsEmptyString(rule, options?.map as FieldMap | undefined, options?.model))
      return notNull;
    return { AND: [notNull, at({ not: '' })] };
  }

  // Prisma's `not` / `notIn` compile to SQL `<>` / `NOT IN`, which drop NULL rows under
  // three-valued logic. check() treats a negation as the complement of its positive form,
  // so a nullable column gets an explicit null arm to keep the two engines in agreement.
  const nullable = isNullableColumn(rule, options);

  if (rule.operator === Operator.in || rule.operator === Operator.notIn) {
    const { values, hasNull } = splitNull(resolveRuleValue(rule, options));
    if (rule.operator === Operator.in) {
      const inList = at({ in: values });
      return hasNull ? orWhere([inList, ...arms]) : inList;
    }
    const notInList = at({ notIn: values });
    if (hasNull) return nullable ? { AND: [notInList, at({ not: null })] } : notInList;
    return orWhere([notInList, ...arms]);
  }

  // Nothing to compare against (see hasNoOperand): no row matches; a negation keeps the
  // absent rows only.
  if (
    !NO_VALUE_OPERATORS.includes(rule.operator) &&
    hasNoOperand(rule, resolveRuleValue(rule, options))
  ) {
    return orWhere(NEGATED_COMPARISON_OPERATORS.includes(rule.operator) ? arms : []);
  }

  if (NEGATED_RANGE_OPERATORS.includes(rule.operator)) {
    // The leaf builder returns the POSITIVE range for these — the negation is this wrapper.
    return orWhere([{ NOT: at(buildLeafFilter(rule, options)) }, ...arms]);
  }

  const filter = at(buildLeafFilter(rule, options));
  if (
    NEGATED_SINGLE_VALUE_OPERATORS.includes(rule.operator) &&
    resolveRuleValue(rule, options) !== null
  ) {
    return orWhere([filter, ...arms]);
  }
  return filter;
};

/** The comparison value: the rule's value source, coerced to the field, moved by its offset. */
const resolveRuleValue = (rule: Rule, options?: BuildOptions): unknown => {
  const value = compileFieldLiteral(
    rule,
    readSource(rule, options),
    walkWith(rule.field, options?.map as FieldMap | undefined, options?.model),
    'toPrisma',
    () => dateConfigOf(options).timeZone,
  );
  return rule.offset === undefined ? value : offsetNumber(value, rule.offset, options);
};

const buildLeafFilter = (rule: Rule, options?: BuildOptions): unknown => {
  if (rule.fuzzy)
    throw new Error(
      'Fuzzy matching has no Prisma equivalent — evaluate it in memory with check().',
    );
  // Lazy resolver: only called by operators that need a value
  const val = () => resolveRuleValue(rule, options);
  // QueryMode only where the connector accepts it; MySQL/SQLite reject `mode` (collation-driven).
  const provider = (options?.datasource?.provider ??
    engineGlobals.get('prismaOptions.datasource.provider')) as PrismaProvider;
  const ci =
    resolveCaseInsensitive(rule.caseInsensitive) && supportsQueryMode(provider)
      ? { mode: 'insensitive' as const }
      : {};

  switch (rule.operator) {
    case Operator.equals:
      return { equals: val() ?? null, ...ci };

    case Operator.notEquals:
      return { not: val() ?? null, ...ci };

    case Operator.lessThan:
      return { lt: val() };

    case Operator.lessThanEquals:
      return { lte: val() };

    case Operator.greaterThan:
      return { gt: val() };

    case Operator.greaterThanEquals:
      return { gte: val() };

    case Operator.in:
      return { in: val() };

    case Operator.notIn:
      return { notIn: val() };

    case Operator.contains:
      return { contains: val(), ...ci };

    case Operator.notContains:
      return { not: { contains: val(), ...ci } };

    case Operator.startsWith:
      return { startsWith: val(), ...ci };

    case Operator.endsWith:
      return { endsWith: val(), ...ci };

    case Operator.matches:
      throw new Error(
        `Operator 'matches' has no Prisma equivalent. Use prisma.$queryRaw for regex filtering.`,
      );

    case Operator.notMatches:
      throw new Error(
        `Operator 'notMatches' has no Prisma equivalent. Use prisma.$queryRaw for regex filtering.`,
      );

    // The POSITIVE range for both: `buildFieldRule` negates the whole clause for notBetween
    // (see NEGATED_RANGE_OPERATORS), because a field filter cannot carry a two-sided negation.
    case Operator.between:
    case Operator.notBetween: {
      const v = val();
      if (!Array.isArray(v) || v.length !== 2) {
        throw new Error(`${rule.operator} operator requires an array of two values`);
      }
      const [min, max] = orderPair(v);
      return { gte: min, lte: max };
    }

    case Operator.isEmpty:
    case Operator.notEmpty:
      // Handled in buildFieldRule — should not reach here
      throw new Error('isEmpty/notEmpty handled at buildFieldRule level');

    case Operator.exists:
      return { not: null };

    case Operator.notExists:
      return { equals: null };

    default:
      throw new Error(`Unknown operator: ${(rule as Rule).operator}`);
  }
};

/**
 * Build the Prisma WHERE for a leaf filter on `field`, map-aware when a map+model is available —
 * the one place every toPrisma leaf (field, date, array) nests its filter.
 * - JSON field mid-path → Prisma JSON path syntax: { metadata: { path: ['theme'], equals: 'dark' } }
 * - All other paths → standard nested relation filter
 */
export const buildMapAwareFilter = (
  field: string,
  filter: unknown,
  options?: BuildOptions,
): PrismaWhere => {
  if (!options?.map || !options?.model) {
    return buildNestedFilter(field, filter);
  }

  const walkResult = walkFieldPath(field, options.map as FieldMap, options.model);
  const parts = field.split('.');

  switch (walkResult.kind) {
    case 'fallback':
    case 'direct':
      return buildNestedFilter(field, filter);

    case 'bridge':
      return {};

    case 'past-scalar':
      throw pastScalarError(field, walkResult.column);

    case 'json-path': {
      // Merge the json path array into the leaf filter, then nest normally
      const jsonFilter = { path: walkResult.jsonPath, ...(filter as object) };
      const fieldUpToJson = parts.slice(0, walkResult.stopIndex).join('.');
      return buildNestedFilter(fieldUpToJson, jsonFilter);
    }
  }
};
