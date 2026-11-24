import { own } from '@inixiative/field-map';
import { bridgeJoinKeys } from '../fieldMap/endpointKey.ts';
import { isRelationEntry } from '../fieldMap/entry.ts';
import { ArrayOperator, Operator } from '../operator.ts';
import { relationKeys } from '../toPrisma/relationUtils.ts';
import { allOf, anyOf } from '../traverse.ts';
import type { Condition, Row } from '../types.ts';
import { distinctTuples, distinctValues } from '../value/distinctValues.ts';
import { prefixConditionFields } from './narrowRule.ts';
import { LensRefusal, lensRootScope, resolvePolicy, resolvePolicyPath } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * The root-level `Condition` selecting root rows whose relation `path` reaches any of `rows`.
 * `path` is a dotted relation path from the lens root as `modelVisits` gives it (`posts`,
 * `memberships.org`, or a terminal joined bridge `crm:Account`); `rows` are rows of the related
 * model (on updates pass both before and after images so re-pointed foreign keys reach both sides;
 * on deletes a before-image works because the last hop binds through its join key without querying
 * the deleted terminal table). Returns `null` when no row carries non-null join key(s).
 *
 * The returned condition is structural (no lens clamps injected) and may name join keys that a
 * narrowing hides: evaluate it with `check()`, or compile it against the base lens via
 * `toPrisma(condition, { map: root, mapName: root.mapName, model: root.model })` where
 * `root = getLensRoot(lens)`. If you narrow it first via `narrowRule(condition, scopeLens)`,
 * `narrowRule` injects clamps on the root and intermediate hops (not the terminal relation, which
 * is bound by join key) — use an immutable tenancy/with-deleted lens so evictions are never
 * filtered out.
 */
export const conditionForRootRowsWithRelatedRows = (
  lensOrNarrowing: Lens | LensNarrowing,
  path: string,
  rows: readonly Row[],
): Condition | null => {
  const caller = 'conditionForRootRowsWithRelatedRows';
  if (path === '')
    throw new LensRefusal(
      `${caller}: the lens root reads its own rows; they are the root rows the path selects`,
      'root_path',
    );
  const policy = resolvePolicy(lensOrNarrowing);
  const { resolution } = resolvePolicyPath(policy, lensRootScope(policy), path);
  if (resolution.outcome !== 'resolved')
    throw new LensRefusal(
      `${caller}: '${path}' does not resolve through the lens (${resolution.outcome})`,
      'not_in_lens',
    );
  const { hops, terminal } = resolution;
  for (const hop of hops.slice(0, -1)) {
    if (hop.entry.kind === 'bridge')
      throw new LensRefusal(
        `${caller}: '${path}' crosses a bridge at '${hop.field}'; only a terminal joined bridge can be bound in the root's source`,
        'unsupported_bridge',
      );
  }
  if (!isRelationEntry(terminal.entry))
    throw new LensRefusal(
      `${caller}: '${path}' ends on a column, not a relation`,
      'not_a_relation',
    );

  let keys: { here: string; there: string }[] | null;
  if (terminal.entry.kind === 'bridge') {
    const joined = bridgeJoinKeys(
      policy.lens.bridges,
      terminal.mapName,
      terminal.model,
      terminal.entry,
    );
    if (!joined)
      throw new LensRefusal(
        `${caller}: '${path}' ends on a supplied bridge with no join key`,
        'unsupported_bridge',
      );
    keys = [joined];
  } else {
    const map = own(policy.lens.maps, terminal.mapName);
    keys = map ? relationKeys(map, terminal.model, terminal.entry) : null;
    if (!keys?.length)
      throw new LensRefusal(
        `${caller}: the map gives no unambiguous join key for '${terminal.field}' on ${terminal.model}`,
        'missing_relation_keys',
      );
  }

  let condition: Condition;
  if (keys.length === 1) {
    const [{ here, there }] = keys;
    const values = distinctValues(
      rows
        .map((row) => own(row as Record<string, unknown>, there))
        .filter((value) => value !== null && value !== undefined),
    );
    if (values.length === 0) return null;
    condition = {
      field: here,
      operator: Operator.in,
      value: values,
      caseInsensitive: false,
    } as Condition;
  } else {
    const rawTuples: unknown[][] = [];
    for (const row of rows) {
      const tuple = keys.map(({ there }) => own(row as Record<string, unknown>, there));
      if (tuple.every((value) => value !== null && value !== undefined)) rawTuples.push(tuple);
    }
    const tuples = distinctTuples(rawTuples);
    if (tuples.length === 0) return null;
    condition = anyOf(
      tuples.map((tuple) =>
        allOf(
          keys.map(
            ({ here }, index) =>
              ({
                field: here,
                operator: Operator.equals,
                value: tuple[index],
                caseInsensitive: false,
              }) as Condition,
          ),
        ),
      ),
    );
  }

  for (const hop of [...hops.slice(0, -1)].reverse()) {
    condition = hop.entry.isList
      ? ({ field: hop.field, arrayOperator: ArrayOperator.any, condition } as Condition)
      : prefixConditionFields(condition, hop.field);
  }
  return condition;
};
