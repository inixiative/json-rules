import { checkField } from '../field';
import { negate } from '../negate';
import { Operator } from '../operator';
import { fieldOf } from '../own';
import type { AggregateRule, Condition, Rule } from '../types';
import { hasWindow } from '../window';
import { comparisonFilter } from './field';
import { groupMembership, groupPath } from './groupStep';
import { matchNothing } from './logical';
import type { BuildOptions, FieldMap, PrismaBuildState, PrismaWhere } from './types';
import { settleLeaf } from './valueSource';

// Forward declaration - provided by condition.ts to avoid circular import
type BuildConditionFn = (
  condition: Condition,
  options?: BuildOptions,
  state?: PrismaBuildState,
) => PrismaWhere;
let buildConditionRef: BuildConditionFn;

export const setConditionBuilderForAggregate = (fn: BuildConditionFn) => {
  buildConditionRef = fn;
};

export const buildAggregateRule = (
  rule: AggregateRule,
  options?: BuildOptions,
  state?: PrismaBuildState,
): PrismaWhere => {
  if (hasWindow(rule))
    throw new Error(
      'Windowing (orderBy/take/skip) is not supported by toPrisma(); evaluate with check().',
    );

  if (!options?.map || !options?.model || !state) {
    throw new Error(
      `Aggregate rules require a FieldMap and model to generate a Prisma plan. ` +
        `Pass { map, model } options to toPrisma().`,
    );
  }

  if (!rule.aggregate.field) {
    throw new Error(
      `Prisma aggregate rules require aggregate.field to specify the numeric field on the related model.`,
    );
  }

  return buildAggregateStep(
    rule,
    options as BuildOptions & { map: FieldMap; model: string },
    state,
  );
};

const buildAggregateStep = (
  rule: AggregateRule,
  options: BuildOptions & { map: FieldMap; model: string },
  state: PrismaBuildState,
): PrismaWhere => {
  const path = groupPath(rule.field, options.map, options.model, 'Aggregate rules');
  const itemField = rule.aggregate.field ?? '';
  const item = fieldOf(options.map, path.target, itemField);
  if (!item)
    throw new Error(`aggregate.field '${itemField}' does not exist on model '${path.target}'.`);
  if (item.kind !== 'scalar' || item.type === 'Json')
    throw new Error(
      `aggregate.field '${itemField}' on model '${path.target}' must be a numeric scalar, got ${item.kind === 'scalar' ? 'Json' : `'${item.kind}'`}.`,
    );

  // The comparison as check() makes it, with its operand read; nothing to compare against
  // matches nothing.
  const leaf = settleLeaf(options)(rule as unknown as Record<string, unknown>);
  if (leaf === null) return matchNothing();
  // A parent with no matching children has the empty aggregate (0) and no group: when the
  // comparison holds for it, select the parents outside the groups where it fails.
  const holdsEmpty =
    checkField(leaf as unknown as Rule, [{}], undefined, undefined, {}, { value: 0 }) === true;
  const target = (holdsEmpty ? negate(leaf as Condition) : leaf) as unknown as Rule;
  const filter = comparisonFilter(target, options);
  const aggregate = { [rule.aggregate.mode === 'sum' ? '_sum' : '_avg']: filter };
  // Prisma can't negate a two-sided bound inside a field filter; NOT the having clause instead.
  const having =
    target.operator === Operator.notBetween
      ? { NOT: { [itemField]: aggregate } }
      : { [itemField]: aggregate };

  const where = rule.condition
    ? buildConditionRef(rule.condition, { ...options, model: path.target }, state)
    : {};
  return groupMembership(state, path, where, having, holdsEmpty);
};
