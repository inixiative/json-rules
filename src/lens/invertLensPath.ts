import { ArrayOperator, Operator } from '../operator';
import { own } from '../own';
import { relationKeys } from '../toPrisma/relationUtils';
import type { Condition, Row } from '../types';
import { prefixConditionFields } from './narrowRule';
import { LensRefusal, lensRootScope, resolvePolicy, resolvePolicyPath } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * The condition, on the lens anchor, that selects the anchor rows whose relation `path` reaches any
 * of `rows` — the inverse of reading `path`. `path` is a relation path as `describeRule`'s `reads`
 * give it (`posts`, `memberships.org`); `rows` are rows of the model it reaches, as written (a
 * deleted row's last image works). The last hop binds through the join key the row carries
 * (`authorId` on a post, or the key a to-one relation points at), so a one-hop path reads no
 * related row at all; each earlier hop wraps it — `any` over a to-many relation, the relation's
 * prefix over a to-one. Null when no row carries the join key. The condition names join keys,
 * which a narrowing may hide: compile it against the lens's base (`getLensRoot`).
 */
export const invertLensPath = (
  lensOrNarrowing: Lens | LensNarrowing,
  path: string,
  rows: readonly Row[],
): Condition | null => {
  const policy = resolvePolicy(lensOrNarrowing);
  if (path === '')
    throw new LensRefusal(
      'invertLensPath: the anchor reads its own rows; they are the anchor rows the path selects',
      'invert_anchor',
    );
  const { resolution } = resolvePolicyPath(policy, lensRootScope(policy), path);
  if (resolution.outcome !== 'resolved')
    throw new LensRefusal(
      `invertLensPath: '${path}' does not resolve through the lens (${resolution.outcome})`,
      'invert_unresolved',
    );
  const { hops, terminal } = resolution;
  for (const hop of hops) {
    if (hop.entry.kind === 'bridge')
      throw new LensRefusal(
        `invertLensPath: '${path}' crosses a bridge at '${hop.field}'; a bridge joins only in memory`,
        'invert_bridge',
      );
    if (hop.entry.kind !== 'object')
      throw new LensRefusal(
        `invertLensPath: '${path}' ends on a column, not a relation`,
        'invert_not_relation',
      );
  }
  const map = own(policy.lens.maps, terminal.mapName);
  const keys = map ? relationKeys(map, terminal.model, terminal.entry) : null;
  if (keys?.length !== 1)
    throw new LensRefusal(
      `invertLensPath: the map gives no single join key for '${terminal.field}' on ${terminal.model}`,
      'invert_no_key',
    );
  const [{ here, there }] = keys;
  const values = [
    ...new Set(
      rows.map((row) => row[there]).filter((value) => value !== null && value !== undefined),
    ),
  ];
  if (values.length === 0) return null;
  let condition: Condition = { field: here, operator: Operator.in, value: values } as Condition;
  for (const hop of [...hops.slice(0, -1)].reverse()) {
    condition = hop.entry.isList
      ? ({ field: hop.field, arrayOperator: ArrayOperator.any, condition } as Condition)
      : prefixConditionFields(condition, hop.field);
  }
  return condition;
};
