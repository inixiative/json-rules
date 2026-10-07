import { check } from '../check';
import { compileFieldLiteral } from '../compileLiteral';
import {
  engineGlobals,
  type PrismaProvider,
  resolveCaseInsensitive,
  supportsQueryMode,
} from '../engineGlobals';
import { enumMatches } from '../enumMatch';
import {
  fuzzyNotCompiled,
  pastScalarError,
  relationNotValue,
  toManyHopError,
  unorderedOperand,
} from '../errors';
import { hasNoOperand, isExistenceTest } from '../field';
import { acceptsEmptyString, comparesText, type FieldShape, ruleShape } from '../fieldMap/shape';
import type { FieldMap } from '../fieldMap/types';
import { fieldEntry, optionalToOneHops, walkFieldPath, walkWith } from '../fieldMap/walk';
import { orderPair, readPair, splitNull } from '../number';
import { Operator } from '../operator';
import {
  COMPLEMENT_OPERATORS,
  comparatorOf,
  NEGATED_OPERATORS,
  NEGATED_RANGE_OPERATORS,
  NEGATED_STRING_OPERATORS,
  ORDERED_OPERATORS,
  SET_OPERATORS,
} from '../operatorCatalog';
import { escapeLikePattern } from '../toSql/quoting';
import type { Condition, Rule } from '../types';
import { prismaAnyNull } from './anyNull';
import { andWhere, notLeaf, orWhere, overFetch } from './logical';
import { offsetNumber } from './offset';
import type { PrismaBuildOptions, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';
import { dateConfigOf, readSource } from './valueSource';

const shapeOf = (
  rule: Pick<Rule, 'field' | 'coerceType'>,
  options?: PrismaBuildOptions,
): FieldShape => ruleShape(rule, options?.map as FieldMap | undefined, options?.model);

const isJson = (shape: FieldShape): boolean => shape === 'json' || shape === 'json-path';

/** The filter value that matches a field's NULL: on Json, Prisma's AnyNull — a DB NULL, a JSON
 *  null, and an absent path all read as null in check(). */
const nullOf = (shape: FieldShape): unknown => {
  if (!isJson(shape)) return null;
  return prismaAnyNull();
};

/** Each optional to-one hop on the path NULL: `{ rel: { col: { equals: null } } }` requires the
 *  relation to exist, so a row without it needs its own arm. */
export const hopArms = (field: string, options?: PrismaBuildOptions): PrismaWhere[] =>
  options?.map && options?.model
    ? optionalToOneHops(field, options.map as FieldMap, options.model).map((hop) =>
        buildNestedFilter(hop, { is: null }),
      )
    : [];

/**
 * The arms that make a negation match the rows where the path is ABSENT — what check() reads as
 * null: the leaf NULL where the map licenses it (a nullable column, a Json path, a scalar list;
 * an `equals: null` arm on a NOT NULL column is a Prisma validation error), and each optional
 * to-one hop NULL.
 */
export const absentArms = (
  rule: Pick<Rule, 'field' | 'coerceType'>,
  options?: PrismaBuildOptions,
): PrismaWhere[] => {
  const shape = shapeOf(rule, options);
  const nullable =
    isJson(shape) ||
    shape === 'list' ||
    fieldEntry(rule.field, options?.map as FieldMap | undefined, options?.model)?.isRequired ===
      false;
  return [
    ...(nullable ? [buildMapAwareFilter(rule.field, { equals: nullOf(shape) }, options)] : []),
    ...hopArms(rule.field, options),
  ];
};

/**
 * `mode: 'insensitive'` when the rule is case-insensitive and compares text: a String column, or a
 * string (or strings) against Json or an undeclared field — and only where the connector accepts
 * QueryMode (MySQL/SQLite are case-insensitive by collation and reject it).
 */
const queryMode = (
  rule: Rule,
  options: PrismaBuildOptions | undefined,
  shape: FieldShape,
  value: unknown,
): { mode?: 'insensitive' } => {
  const provider = (options?.datasource?.provider ??
    engineGlobals.get('prismaOptions.datasource.provider')) as PrismaProvider;
  return resolveCaseInsensitive(rule.caseInsensitive) &&
    supportsQueryMode(provider) &&
    comparesText(shape, value)
    ? { mode: 'insensitive' }
    : {};
};

/** The non-null values that read as empty, as filters: `''`, and `[]` on a list or Json. */
const emptyValues = (shape: FieldShape, emptyString: boolean): Record<string, unknown>[] => {
  if (shape === 'list') return [{ isEmpty: true }];
  const values: Record<string, unknown>[] = emptyString ? [{ equals: '' }] : [];
  return isJson(shape) ? [...values, { equals: [] }] : values;
};

const notEmpty = (empty: Record<string, unknown>): Record<string, unknown> =>
  'isEmpty' in empty ? { isEmpty: false } : { not: empty.equals };

/**
 * Whether a field is empty — null (or absent through an optional relation), '', or an empty list
 * or Json array, as check() reads it — or, with `empty` false, not. One form for the emptiness
 * operators and the array ones.
 */
export const emptinessWhere = (
  field: string,
  shape: FieldShape,
  empty: boolean,
  emptyString: boolean,
  options?: PrismaBuildOptions,
): PrismaWhere => {
  const at = (filter: unknown) => buildMapAwareFilter(field, filter, options);
  const values = emptyValues(shape, emptyString);
  if (empty)
    return orWhere([
      at({ equals: nullOf(shape) }),
      ...hopArms(field, options),
      ...values.map((value) => at(value)),
    ]);
  // A list has no `not`; `isEmpty: false` is NULL — so false — for a NULL list.
  return andWhere([
    ...(shape === 'list' ? [] : [at({ not: nullOf(shape) })]),
    ...values.map((value) => at(notEmpty(value))),
  ]);
};

/** A to-one relation as a field: it exists or it doesn't. */
const buildRelationRule = (rule: Rule, options?: PrismaBuildOptions): PrismaWhere => {
  if (!isExistenceTest(rule)) throw relationNotValue(rule.field);
  const at = (filter: unknown) => buildMapAwareFilter(rule.field, filter, options);
  // check() answers which way it asks: for a missing relation, or a present one.
  return check({ ...rule, field: 'relation' } as Condition, { relation: null }) === true
    ? orWhere([at({ is: null }), ...hopArms(rule.field, options)])
    : at({ isNot: null });
};

export const buildFieldRule = (rule: Rule, options?: PrismaBuildOptions): PrismaWhere => {
  const at = (filter: unknown) => buildMapAwareFilter(rule.field, filter, options);
  const shape = shapeOf(rule, options);
  const arms = () => absentArms(rule, options);
  const emptyString = acceptsEmptyString(
    rule,
    options?.map as FieldMap | undefined,
    options?.model,
  );

  if (shape === 'relation') return buildRelationRule(rule, options);

  switch (rule.operator) {
    // A list filter has no `not`: its complements negate `equals` at the WHERE level.
    case Operator.exists:
      return shape === 'list' ? notLeaf(at({ equals: null })) : at({ not: nullOf(shape) });
    case Operator.notExists: {
      const absent = arms();
      return absent.length ? orWhere(absent) : at({ equals: nullOf(shape) });
    }
    // The emptiness operators OR / AND at the WHERE level: Prisma rejects a mixed null + string
    // list in `in` / `notIn`. isEmpty carries the leaf null arm unconditionally — it is the
    // operator.
    case Operator.isEmpty:
    case Operator.notEmpty:
      return emptinessWhere(
        rule.field,
        shape,
        rule.operator === Operator.isEmpty,
        emptyString,
        options,
      );
  }

  // Nothing to compare against (see hasNoOperand): no row matches; a negation keeps the absent
  // rows only.
  const value = resolveRuleValue(rule, options);
  if (hasNoOperand(rule, value))
    return orWhere(NEGATED_OPERATORS.includes(rule.operator) ? arms() : []);

  // Prisma's list filters have no case-insensitive mode.
  if (
    shape === 'list' &&
    resolveCaseInsensitive(rule.caseInsensitive) &&
    comparesText('text', value)
  )
    throw new Error(
      `A case-insensitive comparison on the list '${rule.field}' has no Prisma form; use toSql() or check().`,
    );

  // An enum compares against its declared values (see enumMatches).
  const enumEntry =
    shape === 'enum'
      ? fieldEntry(rule.field, options?.map as FieldMap | undefined, options?.model)
      : undefined;
  const matched = enumEntry
    ? enumMatches(rule, value, enumEntry, options?.map as FieldMap | undefined)
    : null;
  if (matched) {
    const listed = at({ in: matched.values });
    return matched.matchesNull ? orWhere([listed, ...arms()]) : listed;
  }

  // Prisma's `not` / `notIn` compile to SQL `<>` / `NOT IN`, which drop NULL rows under
  // three-valued logic; a negation is the complement of its positive form in check(), so it
  // carries the absent arms.
  if (SET_OPERATORS.includes(rule.operator)) {
    const { values, hasNull } = splitNull(value);
    // Json has no `in`: one `equals` per value.
    const ci = queryMode(rule, options, shape, values);
    const listed = isJson(shape)
      ? rule.operator === Operator.in
        ? orWhere(values.map((v) => at({ equals: v, ...ci })))
        : andWhere(values.map((v) => at({ not: v, ...ci })))
      : at({ [rule.operator]: values, ...ci });
    if (rule.operator === Operator.in) return hasNull ? orWhere([listed, ...arms()]) : listed;
    return hasNull ? andWhere([listed, at({ not: nullOf(shape) })]) : orWhere([listed, ...arms()]);
  }

  // A string operator's positive form; a Json value contains a string's substring, or a
  // member of an array.
  const positive = (operator: string): PrismaWhere =>
    isJson(shape) && operator === Operator.contains
      ? orWhere([
          at(comparisonFilter({ ...rule, operator }, options)),
          at({ array_contains: [jsonMember(rule.field, value)] }),
        ])
      : at(comparisonFilter({ ...rule, operator: operator as Operator }, options));
  if (rule.operator === Operator.contains) return positive(Operator.contains);

  // A negated string operator or range negates its positive form at the WHERE level: no field
  // filter carries it on Json or a list. Prisma's Json filters can't test a value's type — the
  // positive is NULL for the other types — so on Json the complement, which keeps them, has no
  // form.
  const complemented = NEGATED_STRING_OPERATORS.includes(rule.operator)
    ? COMPLEMENT_OPERATORS[rule.operator]
    : NEGATED_RANGE_OPERATORS.includes(rule.operator)
      ? Operator.between
      : undefined;
  if (complemented) {
    if (isJson(shape))
      throw new Error(
        `'${rule.operator}' on the Json value '${rule.field}' has no Prisma form (it keeps values of other types); use toSql() or check().`,
      );
    return orWhere([notLeaf(positive(complemented)), ...arms()]);
  }

  const filter = at(comparisonFilter(rule, options));
  // `equals null` is the is-null sentinel: a path through an absent relation is null too.
  if (rule.operator === Operator.equals && value === null)
    return orWhere([filter, ...hopArms(rule.field, options)]);
  if (rule.operator === Operator.notEquals && shape === 'list')
    return value === null
      ? notLeaf(at({ equals: null }))
      : orWhere([notLeaf(at({ equals: value })), ...arms()]);
  return rule.operator === Operator.notEquals && value !== null
    ? orWhere([filter, ...arms()])
    : filter;
};

/** The comparison value: the rule's value source, coerced to the field, moved by its offset. */
const resolveRuleValue = (rule: Rule, options?: PrismaBuildOptions): unknown => {
  const value = compileFieldLiteral(
    rule,
    readSource(rule, options),
    walkWith(rule.field, options?.map as FieldMap | undefined, options?.model),
    'toPrisma',
    () => dateConfigOf(options).timeZone,
  );
  return rule.offset === undefined ? value : offsetNumber(value, rule.offset, options);
};

/** A leaf's comparison as a Prisma field filter, in the form its field's shape takes (a negated
 *  range is its positive form; the caller negates the clause). */
export const comparisonFilter = (rule: Rule, options?: PrismaBuildOptions): unknown => {
  const fuzzy = fuzzyNotCompiled(rule);
  if (fuzzy) throw fuzzy;
  const shape = shapeOf(rule, options);
  const val = () => resolveRuleValue(rule, options);
  const ci = (value: unknown) => queryMode(rule, options, shape, value);
  // String matching on Json is `string_*`; containment on a list is `has`.
  const match = (op: 'contains' | 'startsWith' | 'endsWith') => {
    const value = val();
    if (shape === 'list') {
      if (op !== 'contains')
        throw new Error(`Operator '${op}' does not apply to the list '${rule.field}'.`);
      return { has: value };
    }
    const key = isJson(shape) ? JSON_MATCH[op] : op;
    // Prisma matches with LIKE and passes % and _ through: escape them, as toSql does.
    const literal = typeof value === 'string' ? escapeLikePattern(value) : value;
    return { [key]: literal, ...ci(value) };
  };

  const unordered = unorderedOperand(rule.operator, val());
  if (unordered) throw unordered;
  const comparator = comparatorOf(rule.operator, 'field');
  if (comparator && ORDERED_OPERATORS.includes(rule.operator)) return { [comparator]: val() };

  switch (rule.operator) {
    case Operator.equals: {
      const value = val() ?? nullOf(shape);
      return { equals: value, ...ci(value) };
    }
    case Operator.notEquals: {
      const value = val() ?? nullOf(shape);
      return { not: value, ...ci(value) };
    }
    // A field's set membership is built by buildFieldRule; an aggregate's `having` takes it here.
    case Operator.in:
    case Operator.notIn:
      return { [rule.operator]: val() };
    case Operator.contains:
      return match('contains');
    case Operator.startsWith:
      return match('startsWith');
    case Operator.endsWith:
      return match('endsWith');
    case Operator.matches:
    case Operator.notMatches:
      throw new Error(
        `Operator '${rule.operator}' has no Prisma equivalent. Use prisma.$queryRaw for regex filtering.`,
      );
    // The POSITIVE range for both: `buildFieldRule` negates the whole clause for notBetween,
    // because a field filter cannot carry a two-sided negation.
    case Operator.between:
    case Operator.notBetween: {
      const [min, max] = orderPair(readPair(val(), rule.operator));
      return { gte: min, lte: max };
    }
    default:
      // Negated string operators / emptiness / existence are built at the WHERE level.
      throw new Error(`Operator '${rule.operator}' is built by buildFieldRule`);
  }
};

/** A Json array member Prisma can match exactly: `array_contains` reads an object or a list
 *  partially (its fields / members contained), unlike check()'s equal member. */
const jsonMember = (field: string, value: unknown): unknown => {
  if (typeof value === 'object' && value !== null)
    throw new Error(
      `Membership of an object or a list in the Json array '${field}' has no exact Prisma form; use toSql() or check().`,
    );
  return value;
};

const JSON_MATCH = {
  contains: 'string_contains',
  startsWith: 'string_starts_with',
  endsWith: 'string_ends_with',
} as const;

/**
 * Build the Prisma WHERE for a leaf filter on `field`, map-aware when a map+model is available —
 * the one place every toPrisma leaf (field, date, array) nests its filter.
 * - JSON field mid-path → Prisma JSON path syntax: { metadata: { path: ['theme'], equals: 'dark' } }
 * - All other paths → standard nested relation filter
 */
export const buildMapAwareFilter = (
  field: string,
  filter: unknown,
  options?: PrismaBuildOptions,
): PrismaWhere => {
  if (!options?.map || !options?.model) {
    return buildNestedFilter(field, filter);
  }

  const walkResult = walkFieldPath(field, options.map as FieldMap, options.model);
  const toMany = walkResult.hops.find((hop) => hop.entry.isList);
  if (toMany) throw toManyHopError(field, toMany);
  const parts = field.split('.');

  switch (walkResult.kind) {
    case 'fallback':
    case 'direct':
      return buildNestedFilter(field, filter);

    case 'bridge':
      return overFetch();

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
