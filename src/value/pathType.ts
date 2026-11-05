import { isRelationEntry } from '../fieldMap/entry';
import type { Lens, LensNarrowing } from '../lens/types';
import type { ValueType } from '../types';
import { columnKind, resolveValuePath, rowPath } from './resolveValuePath';
import { refuse } from './valueTypeIssue';

/** A path read's type: its column's kind through the lens, nullable unless the map declares it
 *  required. Refuses a path through a to-many relation or one naming a relation's rows. */
export const pathType = (lens: Lens | LensNarrowing, ref: string, path: string): ValueType => {
  const resolved = resolveValuePath(lens, rowPath(ref, path), path);
  if (resolved.viaList)
    refuse(
      path,
      'to_many_path',
      `'${ref}' reads through the to-many relation '${resolved.viaList}'; aggregate its rows`,
    );
  if (isRelationEntry(resolved.entry))
    refuse(
      path,
      'relation_not_value',
      `'${ref}' names a relation's rows, not a value; aggregate them`,
    );
  return {
    kind: columnKind(resolved),
    isList: resolved.entry.isList === true,
    nullable: resolved.json || resolved.entry.isRequired !== true,
  };
};
