import type { FieldMap } from '../fieldMap/types';
import { walkFieldPath } from '../fieldMap/walk';
import { modelOf } from '../own';
import { notLeaf } from './logical';
import { relationKeys } from './relationUtils';
import { emit } from './sentinels';
import type { GroupByStep, PrismaBuildState, PrismaWhere } from './types';
import { buildNestedFilter } from './utils';

// A count or aggregate over a relation compiles to a groupBy step on the related model and a
// membership filter on the parent: to-one relations, then the to-many relation grouped over.

type GroupPath = {
  /** The dotted to-one hops before the to-many relation ('' when it is on the model itself). */
  through: string;
  /** The model grouped (the to-many relation's target). */
  target: string;
  /** The parent's key and the target's key that point at it. */
  parentKey: string;
  targetKey: string;
};

/** The path a group step aggregates over; `rule` names the rule kind in errors. */
export const groupPath = (
  field: string,
  map: FieldMap,
  model: string,
  rule: 'Count operators' | 'Aggregate rules',
): GroupPath => {
  const segments = field.split('.');
  const walk = walkFieldPath(field, map, model);
  if (walk.kind !== 'direct' || walk.entry.kind !== 'object') {
    const on = walk.hops.at(-1)?.entry.type ?? model;
    throw new Error(
      `Field '${segments[walk.hops.length]}' is not a relation in model '${on}'. ${rule} require a relation field.`,
    );
  }
  const toMany = walk.hops.find((hop) => hop.entry.isList);
  if (toMany)
    throw new Error(
      `Intermediate field '${toMany.field}' in path '${field}' is a list relation. ` +
        `Only the final segment can be a list relation for ${rule.toLowerCase()}.`,
    );
  if (!walk.entry.isList)
    throw new Error(
      `Field '${walk.column}' is not a list relation in model '${walk.model}'. ${rule} only apply to one-to-many or many-to-many relations.`,
    );
  const keys = relationKeys(map, walk.model, walk.entry);
  if (!keys) {
    const implicitM2M = Object.values(modelOf(map, walk.entry.type)?.fields ?? {}).some(
      (f) => f.kind === 'object' && f.type === walk.model && f.isList && !f.fromFields?.length,
    );
    throw new Error(
      implicitM2M
        ? `'${walk.model}.${walk.column}' is an implicit many-to-many relation. ${rule} require an ` +
            `explicit join model with a FK — convert to an explicit @relation or use prisma.$queryRaw.`
        : `Cannot determine FK relationship between '${walk.model}' and '${walk.entry.type}'. ` +
            `Ensure the FieldMap contains both sides of the relation.`,
    );
  }
  if (keys.length > 1)
    throw new Error(
      `${rule} do not support composite FK relations ('${walk.model}.${walk.column}'). Use prisma.$queryRaw.`,
    );
  return {
    through: walk.hops.map((hop) => hop.field).join('.'),
    target: walk.entry.type,
    parentKey: keys[0].here,
    targetKey: keys[0].there,
  };
};

/**
 * Push a groupBy step and return the parents it selects — or, with `complement`, the parents it
 * doesn't. A groupBy only yields groups with at least one row, so a parent with no (matching)
 * children never appears in it: a predicate that holds for that empty case compiles as the
 * complement of the step for its negation.
 */
export const groupMembership = (
  state: PrismaBuildState,
  path: GroupPath,
  where: PrismaWhere,
  having: Record<string, unknown>,
  complement: boolean,
): PrismaWhere => {
  const step: GroupByStep = {
    operation: 'groupBy',
    model: path.target,
    args: { by: [path.targetKey], where, having },
    extract: path.targetKey,
  };
  const ref = emit({ __step: state.steps.length });
  state.steps.push(step);
  const membership = { [path.parentKey]: { in: ref } };
  const selected = complement ? notLeaf(membership) : membership;
  return path.through ? buildNestedFilter(path.through, selected) : selected;
};
