import { own } from '../own';
import { collectChain, getRoot, isLens } from './chain.ts';
import { assertValidNarrowing } from './narrowing.ts';
import type { Lens, LensNarrowing } from './types.ts';

/**
 * A lens as stored, one record per layer: its `id`, the ids of every layer it composes with —
 * the base lens first, the nearest parent last — and its own part. The base lens is the
 * root-most layer: the lens itself, with no parents.
 */
export type StoredLens = { id: string; parents: string[] } & (Lens | Omit<LensNarrowing, 'parent'>);

const isBase = (record: StoredLens): record is StoredLens & Lens => 'maps' in record;

/**
 * The composed lens a stored layer resolves to: its parents, read from `records`, nested from
 * the base down, each layer validated against the ones above it. Fails closed on a missing
 * record, a base that isn't first, or a parent whose own parents disagree with the list.
 */
export const composeLens = (
  id: string,
  records: Record<string, StoredLens>,
): Lens | LensNarrowing => {
  const read = (at: string): StoredLens => {
    const record = own(records, at);
    if (!record) throw new Error(`composeLens: no stored lens '${at}'`);
    return record;
  };
  const ids = [...read(id).parents, id];
  if (new Set(ids).size !== ids.length)
    throw new Error(`composeLens: '${id}' lists a layer twice in its parents`);

  let lens: Lens | LensNarrowing | null = null;
  for (const [depth, at] of ids.entries()) {
    const record = read(at);
    const { id: _id, parents, ...part } = record;
    if (parents.join('\u0000') !== ids.slice(0, depth).join('\u0000'))
      throw new Error(
        `composeLens: '${at}' composes with [${parents.join(', ')}], not [${ids.slice(0, depth).join(', ')}] as '${id}' lists`,
      );
    const base = isBase(record);
    if (base !== (depth === 0))
      throw new Error(
        depth === 0
          ? `composeLens: '${at}' is not a base lens, so it can't head '${id}''s parents`
          : `composeLens: '${at}' is a base lens, so it can only head a chain`,
      );
    if (lens === null) {
      lens = part as Lens;
      continue;
    }
    const layer: LensNarrowing = { parent: lens, ...(part as Omit<LensNarrowing, 'parent'>) };
    assertValidNarrowing(layer);
    lens = layer;
  }
  return lens as Lens | LensNarrowing;
};

/** A composed lens as the records `composeLens` reads back: one per layer, the base first,
 *  named by `ids` in the same order. */
export const storeLens = (lens: Lens | LensNarrowing, ids: readonly string[]): StoredLens[] => {
  const chain = isLens(lens) ? [] : collectChain(lens);
  if (ids.length !== chain.length + 1)
    throw new Error(
      `storeLens: the lens has ${chain.length + 1} layers, base included, but ${ids.length} ids`,
    );
  return [
    { ...getRoot(lens), id: ids[0], parents: [] },
    ...chain.map(({ parent: _parent, ...part }, depth) => ({
      ...part,
      id: ids[depth + 1],
      parents: ids.slice(0, depth + 1),
    })),
  ];
};
