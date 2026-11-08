import { aggregatePathUnsupported, unknownAggregateMode, windowUnsupported } from '../errors';
import { checkField, hasNoOperand } from '../field';
import { isJsonEntry } from '../fieldMap/entry';
import type { FieldMap } from '../fieldMap/types';
import { conditionTouchesBridge } from '../fieldMap/walk';
import { negate } from '../negate';
import { Operator } from '../operator';
import {
  AGGREGATE_MODES,
  EQUALITY_OPERATORS,
  type FieldKind,
  NEGATED_OPERATORS,
  NEGATED_RANGE_OPERATORS,
  NO_VALUE_OPERATORS,
  NUMERIC_KINDS,
} from '../operatorCatalog';
import { fieldOf } from '../own';
import type { AggregateRule, Condition, Rule } from '../types';
import { hasPath } from '../valueSource';
import { hasWindow, windowRewrite } from '../window';
import { nestedScope } from './columnRef';
import { comparisonFilter, hopArms } from './field';
import { groupMembership, groupPath } from './groupStep';
import { andWhere, matchAll, matchNothing, notLeaf, orWhere, overFetch } from './logical';
import { buildCondition } from './recurse';
import type { PrismaBuildState, PrismaWhere, ToPrismaOptions } from './types';
import { settleLeaf } from './valueSource';

/** A relation aggregate with no `aggregate.field`: Prisma groups a column of the related rows. */
export const aggregateFieldRequired = (): Error =>
  new Error(
    `Prisma aggregate rules require aggregate.field to specify the numeric field on the related model.`,
  );

/** Why Prisma can't aggregate `itemField` on the related model, or null: it reads a numeric
 *  column as stored — a coerceType can't cast it. */
export const aggregateItemError = (
  map: FieldMap,
  target: string,
  itemField: string,
): Error | null => {
  const item = fieldOf(map, target, itemField);
  if (!item)
    return new Error(`aggregate.field '${itemField}' does not exist on model '${target}'.`);
  if (
    item.kind === 'scalar' &&
    !isJsonEntry(item) &&
    NUMERIC_KINDS.includes(item.type as FieldKind)
  )
    return null;
  return new Error(
    `aggregate.field '${itemField}' on model '${target}' must be a numeric scalar, got '${item.kind === 'scalar' ? item.type : item.kind}'.`,
  );
};

export const buildAggregateRule = (
  rule: AggregateRule,
  options?: ToPrismaOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (hasPath(rule)) throw aggregatePathUnsupported(rule.path);
  if (hasWindow(rule)) {
    const rewritten = windowRewrite(rule);
    if (!rewritten) throw windowUnsupported('toPrisma');
    return buildCondition(rewritten, options, state);
  }

  if (!options?.map || !options?.model || !state) {
    throw new Error(
      `Aggregate rules require a FieldMap and model to generate a Prisma plan. ` +
        `Pass { map, model } options to toPrisma().`,
    );
  }

  if (!AGGREGATE_MODES.includes(rule.aggregate.mode))
    throw unknownAggregateMode(rule.aggregate.mode);
  if (!rule.aggregate.field) throw aggregateFieldRequired();

  return buildAggregateStep(
    rule,
    options as ToPrismaOptions & { map: FieldMap; model: string },
    state,
  );
};

const buildAggregateStep = (
  rule: AggregateRule,
  options: ToPrismaOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  const path = groupPath(rule.field, options.map, options.model, 'Aggregate rules');
  // A condition that crosses a bridge is unknown here: the step would aggregate every child.
  // Over-fetch and let check() decide.
  if (rule.condition && conditionTouchesBridge(rule.condition, options.map, path.target))
    return overFetch();
  const itemField = rule.aggregate.field ?? '';
  const itemError = aggregateItemError(options.map, path.target, itemField);
  if (itemError) throw itemError;

  // The comparison as check() makes it, with its operand read; nothing to compare against
  // matches nothing.
  // Built only where a group step reads it: a step the condition pushes runs whether read or not.
  const where = () =>
    rule.condition
      ? buildCondition(
          rule.condition,
          nestedScope({ ...options, model: path.target }, options, true),
          state,
        )
      : matchAll();
  if (NO_VALUE_OPERATORS.includes(rule.operator))
    return presence(rule, rule.operator === Operator.exists, where, path, options, state);

  // The Prisma rail reads every operand at compile time: nothing is left UNREAD. The items are a
  // numeric column, so a coerceType parses nothing; the number compares as is.
  const { coerceType: _parsed, ...comparison } = rule;
  const leaf = settleLeaf(options)(comparison as unknown as Record<string, unknown>, 0) as Record<
    string,
    unknown
  > | null;
  // Against null, equals / notEquals ask whether the aggregate has a number, as on a field: a sum
  // always has one, though Prisma's _sum over only NULL items is NULL.
  if (leaf !== null && leaf.value === null && EQUALITY_OPERATORS.includes(rule.operator))
    return presence(rule, rule.operator === Operator.notEquals, where, path, options, state);
  // Nothing to compare against: a negation holds where the aggregate has no number, as it does on
  // a NULL field; a positive comparison holds nowhere.
  if (leaf === null || hasNoOperand(leaf as unknown as Rule, leaf.value))
    return NEGATED_OPERATORS.includes(rule.operator)
      ? presence(rule, false, where, path, options, state)
      : matchNothing();
  const empty = rule.aggregate.mode === 'sum' ? 0 : null;
  const holdsEmpty =
    checkField(leaf as unknown as Rule, [{}], undefined, {}, { value: empty }) === true;
  const target = (holdsEmpty ? negate(leaf as Condition) : leaf) as unknown as Rule;
  const filter = comparisonFilter(target, options);
  const aggregate = { [rule.aggregate.mode === 'sum' ? '_sum' : '_avg']: filter };
  const having = NEGATED_RANGE_OPERATORS.includes(target.operator)
    ? notLeaf({ [itemField]: aggregate })
    : { [itemField]: aggregate };

  const membership = groupMembership(state, path, where(), having, holdsEmpty);
  return holdsEmpty ? orWhere([membership, ...hopArms(rule.field, options)]) : membership;
};

/** Whether the aggregate has a number: a sum always does (0 over nothing); an average where at
 *  least one item it reads has a value. */
const presence = (
  rule: AggregateRule,
  exists: boolean,
  where: () => PrismaWhere,
  path: ReturnType<typeof groupPath>,
  options: ToPrismaOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  if (rule.aggregate.mode === 'sum') return exists ? matchAll() : matchNothing();
  const valued = andWhere([where(), { [rule.aggregate.field as string]: { not: null } }]);
  const membership = groupMembership(state, path, valued, undefined, !exists);
  return exists ? membership : orWhere([membership, ...hopArms(rule.field, options)]);
};
