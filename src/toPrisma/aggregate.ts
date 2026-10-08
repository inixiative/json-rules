import { unknownAggregateMode, windowUnsupported } from '../errors';
import { checkField, hasNoOperand } from '../field';
import { isJsonEntry } from '../fieldMap/entry';
import type { FieldMap } from '../fieldMap/types';
import { conditionTouchesBridge } from '../fieldMap/walk';
import { negate } from '../negate';
import { AGGREGATE_MODES, NEGATED_RANGE_OPERATORS } from '../operatorCatalog';
import { fieldOf } from '../own';
import type { AggregateRule, Condition, Rule } from '../types';
import { hasWindow, windowRewrite } from '../window';
import { nestedScope } from './columnRef';
import { comparisonFilter, hopArms } from './field';
import { groupMembership, groupPath } from './groupStep';
import { matchAll, matchNothing, notLeaf, orWhere, overFetch } from './logical';
import { buildCondition } from './recurse';
import type { PrismaBuildState, PrismaWhere, ToPrismaOptions } from './types';
import { settleLeaf } from './valueSource';

export const buildAggregateRule = (
  rule: AggregateRule,
  options?: ToPrismaOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
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
  if (!rule.aggregate.field) {
    throw new Error(
      `Prisma aggregate rules require aggregate.field to specify the numeric field on the related model.`,
    );
  }

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
  const item = fieldOf(options.map, path.target, itemField);
  if (!item)
    throw new Error(`aggregate.field '${itemField}' does not exist on model '${path.target}'.`);
  if (item.kind !== 'scalar' || isJsonEntry(item))
    throw new Error(
      `aggregate.field '${itemField}' on model '${path.target}' must be a numeric scalar, got ${item.kind === 'scalar' ? 'Json' : `'${item.kind}'`}.`,
    );

  // The comparison as check() makes it, with its operand read; nothing to compare against
  // matches nothing.
  const leaf = settleLeaf(options)(rule as unknown as Record<string, unknown>);
  if (leaf === null || hasNoOperand(leaf as unknown as Rule, leaf.value)) return matchNothing();
  // A parent with no matching children has the empty aggregate (0) and no group: when the
  // comparison holds for it, select the parents outside the groups where it fails.
  const holdsEmpty =
    checkField(leaf as unknown as Rule, [{}], undefined, {}, { value: 0 }) === true;
  const target = (holdsEmpty ? negate(leaf as Condition) : leaf) as unknown as Rule;
  const filter = comparisonFilter(target, options);
  const aggregate = { [rule.aggregate.mode === 'sum' ? '_sum' : '_avg']: filter };
  // Prisma can't negate a two-sided bound inside a field filter; NOT the having clause instead.
  const having = NEGATED_RANGE_OPERATORS.includes(target.operator)
    ? notLeaf({ [itemField]: aggregate })
    : { [itemField]: aggregate };

  const where = rule.condition
    ? buildCondition(rule.condition, nestedScope({ ...options, model: path.target }), state)
    : matchAll();
  const membership = groupMembership(state, path, where, having, holdsEmpty);
  // check() reads the array under an absent to-one relation as empty.
  return holdsEmpty ? orWhere([membership, ...hopArms(rule.field, options)]) : membership;
};
