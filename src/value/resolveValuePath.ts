import { UsageError } from '../errors';
import { isRelationEntry } from '../fieldMap/entry';
import { entryKind } from '../fieldMap/shape';
import type { FieldMapEntry } from '../fieldMap/types';
import type { Lens, LensNarrowing } from '../lens/types';
import { walkLensPath } from '../lens/walkLensPath';
import { FieldKind } from '../operatorCatalog';
import { parseScopeRef } from '../scope';
import { refuse } from './valueTypeIssue';

export type ResolvedValuePath = { entry: FieldMapEntry; viaList: string | null; json: boolean };

/** A top-level ref reads the row: bare, or `$.` (the only scope in reach). */
export const rowPath = (ref: string, path: string): string => {
  const scoped = parseScopeRef(ref);
  if (!scoped) return ref;
  if (scoped.depth > 1)
    refuse(path, 'scope_out_of_bounds', `'${ref}' reaches past the row a value expression reads`);
  return scoped.path;
};

export const needLens = (
  lens: Lens | LensNarrowing | undefined,
  what: string,
): Lens | LensNarrowing => {
  if (!lens) throw new UsageError(`inferValueType needs a lens to type ${what}`);
  return lens;
};

/** Where a ref lands through the lens: its entry, the to-many relation it crosses (if any), and
 *  whether it reads into Json. */
export const resolveValuePath = (
  lens: Lens | LensNarrowing,
  ref: string,
  path: string,
): ResolvedValuePath => {
  const resolution = walkLensPath(lens, ref);
  if (resolution.outcome !== 'resolved')
    return refuse(
      path,
      'unresolved_path',
      `'${ref}' does not resolve through the lens (${resolution.outcome})`,
    );
  const listHop = resolution.hops
    .slice(0, -1)
    .find((hop) => isRelationEntry(hop.entry) && hop.entry.isList);
  return {
    entry: resolution.terminal.entry,
    viaList: listHop ? listHop.field : null,
    json: resolution.jsonSubPath.length > 0 || resolution.terminal.entry.type === FieldKind.Json,
  };
};

/** The kind of a column, or of each value of a scalar list column. */
export const columnKind = (resolved: ResolvedValuePath): FieldKind | null =>
  resolved.json ? FieldKind.Json : (entryKind({ ...resolved.entry, isList: false }) ?? null);
