import { own } from '@inixiative/field-map';
import { UsageError } from '../errors.ts';
import { bridgeJoinKeys } from '../fieldMap/endpointKey.ts';
import { isRelationEntry } from '../fieldMap/entry.ts';
import { ArrayOperator, Operator } from '../operator.ts';
import { toPrisma } from '../toPrisma/index.ts';
import { relationKeys } from '../toPrisma/relationUtils.ts';
import type { ToPrismaOptions, ToPrismaResult } from '../toPrisma/types.ts';
import { allOf, anyOf } from '../traverse.ts';
import type { Condition, Row } from '../types.ts';
import { distinctTuples, distinctValues } from '../value/distinctValues.ts';
import type { LensSelectOptions } from './lensRows.ts';
import { narrowRule, prefixConditionFields } from './narrowRule.ts';
import {
  LensRefusal,
  lensRootScope,
  type Policy,
  resolvePolicy,
  resolvePolicyPath,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** Changed rows at one relation path from the lens root, as `modelVisits` reports it. */
export type RelatedRowsAtPath = {
  path: string;
  rows: readonly Row[];
};

const conditionForPath = (
  policy: Policy,
  path: string,
  rows: readonly Row[],
  caller: string,
): Condition | null => {
  if (path === '')
    throw new LensRefusal(
      `${caller}: the lens root reads its own rows; they are the root rows the path selects`,
      'root_path',
    );
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
    if (!isRelationEntry(hop.entry))
      throw new LensRefusal(
        `${caller}: '${path}' crosses a column at '${hop.field}', not a relation`,
        'not_a_relation',
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

/**
 * The root-level `Condition` selecting root rows whose relation `path` reaches any of `rows`.
 * `path` is a dotted relation path from the lens root as `modelVisits` gives it (`posts`,
 * `memberships.org`, or a terminal joined bridge `crm:Account`); `rows` are rows of the related
 * model (on updates pass both before and after images so re-pointed foreign keys reach both sides;
 * on 1-hop deletes a before-image works because the last hop binds through its join key without
 * querying the related table). Returns `null` when no row carries non-null join key(s).
 *
 * The returned condition names join keys that a narrowing may hide — evaluate it with `check()`,
 * or use `toPrismaForRootRowsWithRelatedRows` to compile it safely against a database through the
 * lens.
 */
export const conditionForRootRowsWithRelatedRows = (
  lensOrNarrowing: Lens | LensNarrowing,
  path: string,
  rows: readonly Row[],
): Condition | null =>
  conditionForPath(
    resolvePolicy(lensOrNarrowing),
    path,
    rows,
    'conditionForRootRowsWithRelatedRows',
  );

/**
 * Compile a Prisma query plan on the lens root selecting root rows that have any of `related`
 * (`{ path, rows }`, or a list of them combined with OR). Validates every path through the lens,
 * binds join keys even when hidden by `picks` / `omits`, narrows through every layer of the lens
 * via `narrowRule` (terminal rows are caller-supplied, so terminal-hop clamps are not re-evaluated
 * in the database), and returns `null` when no entry carries non-null join keys.
 */
export const toPrismaForRootRowsWithRelatedRows = (
  lensOrNarrowing: Lens | LensNarrowing,
  related: RelatedRowsAtPath | readonly RelatedRowsAtPath[],
  options?: LensSelectOptions,
): ToPrismaResult | null => {
  const policy = resolvePolicy(lensOrNarrowing);
  const list = Array.isArray(related) ? related : [related as RelatedRowsAtPath];
  const conditions: Condition[] = [];
  for (const entry of list) {
    const condition = conditionForPath(
      policy,
      entry.path,
      entry.rows,
      'toPrismaForRootRowsWithRelatedRows',
    );
    if (condition !== null) conditions.push(condition);
  }
  if (conditions.length === 0) return null;

  const combined = anyOf(conditions);
  const root = policy.lens;
  const narrowed = narrowRule(combined, lensOrNarrowing);
  const compileOptions: ToPrismaOptions = {
    ...options,
    map: root,
    mapName: root.mapName,
    model: root.model,
  };

  // Mirror compileWithLens: only classify as LensRefusal when the lens's clamps caused the failure,
  // never when the caller's own row data failed literal compilation.
  try {
    return toPrisma(narrowed, compileOptions);
  } catch (error) {
    if (error instanceof LensRefusal || error instanceof UsageError) throw error;
    try {
      toPrisma(combined, compileOptions);
    } catch {
      throw error;
    }
    throw new LensRefusal(
      `toPrismaForRootRowsWithRelatedRows: the lens's clamps have no Prisma form — ${(error as Error).message}`,
      'unsupported_clamp',
    );
  }
};
