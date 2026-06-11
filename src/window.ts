import { orderBy as lodashOrderBy } from 'lodash-es';
import type { WindowFields } from './types';

/** True when a rule carries any windowing selector (orderBy/take/skip). */
export const hasWindow = (rule: WindowFields): boolean =>
  !!rule.orderBy?.length || rule.take !== undefined || rule.skip !== undefined;

/**
 * Apply the ordered-window pipeline to an array: order → skip → take.
 * Direction comes from orderBy `dir`; take/skip are positive offsets.
 */
export const applyWindow = <T>(items: T[], rule: WindowFields): T[] => {
  let out = items;
  if (rule.orderBy?.length) {
    out = lodashOrderBy(
      out,
      rule.orderBy.map((o) => o.field),
      rule.orderBy.map((o) => o.dir),
    );
  }
  if (rule.skip !== undefined) out = out.slice(rule.skip);
  if (rule.take !== undefined) out = out.slice(0, rule.take);
  return out;
};
