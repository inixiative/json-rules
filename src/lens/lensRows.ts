import { type CheckOptions, check } from '../check';
import { type MapVisit, relationTargetOf } from '../fieldMap/walk.ts';
import { modelOf, own, ownEntry } from '../own';
import { toPrisma } from '../toPrisma/index.ts';
import type { PrismaWhere, ToPrismaOptions, WhereStep } from '../toPrisma/types.ts';
import { allOf } from '../traverse';
import type { Row } from '../types';
import {
  isFieldVisible,
  type Policy,
  resolvePolicy,
  resolveVisit,
  type VisitEffect,
} from './policy.ts';
import { readPaths } from './readPaths.ts';
import type { Lens, LensNarrowing } from './types.ts';

/** A Prisma `select` tree: a column, or a relation with its own `select` and, to-many, `where`. */
export type LensSelect = { [field: string]: true | LensRelationSelect };
export type LensRelationSelect = { select?: LensSelect; where?: PrismaWhere };

/** What a grant's compile reads: the clock and context, never a schema (the lens is it). */
export type LensSelectOptions = Omit<ToPrismaOptions, 'map' | 'mapName' | 'model' | 'lens'>;

/** `keepGrantColumns`: keep the columns the lens's `where`s read, though it hides them. The rest
 *  is what each `where` is checked with. */
export type ProjectRowsOptions = CheckOptions & { keepGrantColumns?: boolean };

// The paths a visit must keep, as a tree of segments.
type PathTree = { [segment: string]: PathTree };

const addPaths = (tree: PathTree, paths: readonly string[]): PathTree => {
  for (const path of paths) {
    let at = tree;
    for (const segment of path.split('.')) at = ownEntry(at, segment, () => ({}));
  }
  return tree;
};

const mergeTrees = (into: PathTree, from: PathTree): PathTree => {
  for (const [segment, below] of Object.entries(from))
    mergeTrees(
      ownEntry(into, segment, () => ({})),
      below,
    );
  return into;
};

// The columns a visit's grants read, relative to its model.
const grantPaths = (effect: VisitEffect): string[] => effect.whereClauses.flatMap(readPaths);

// A visit the lens projects (`declared`: its relations follow their narrowing), one it shows off a
// declared path (`shallow`: its columns, no relations), or one only a grant reads (`paths`).
type Mode = 'declared' | 'shallow' | 'paths';

const rootVisit = (policy: Policy): MapVisit => ({
  mapName: policy.lens.mapName,
  modelName: policy.lens.model,
  relPath: [],
});

const childVisit = (
  at: MapVisit,
  field: string,
  target: { mapName: string; modelName: string },
) => ({
  ...target,
  relPath: [...at.relPath, field],
});

// The relation a visible field opens: through its declared narrowing, or shallow.
const openedMode = (mode: Mode, effect: VisitEffect, field: string): Mode =>
  mode === 'declared' ? (effect.relations.has(field) ? 'declared' : 'shallow') : 'paths';

const grantWhere = (
  policy: Policy,
  at: MapVisit,
  effect: VisitEffect,
  options: LensSelectOptions,
): PrismaWhere | undefined => {
  if (!effect.whereClauses.length) return undefined;
  const plan = toPrisma(allOf(effect.whereClauses), {
    ...options,
    map: policy.lens,
    mapName: at.mapName,
    model: at.modelName,
  });
  if (plan.steps.length > 1)
    throw new Error(
      `toLensSelect: the grant on '${at.relPath.join('.')}' needs a counting step (executePrismaPlan), which a relation's where in a select can't run`,
    );
  const { where } = plan.steps[0] as WhereStep;
  return Object.keys(where).length ? where : undefined;
};

const selectAt = (
  policy: Policy,
  at: MapVisit,
  mode: Mode,
  extra: PathTree,
  options: LensSelectOptions,
): LensSelect => {
  const fields = modelOf(own(policy.lens.maps, at.mapName), at.modelName)?.fields ?? {};
  const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
  const paths = mode === 'paths' ? extra : addPaths(mergeTrees({}, extra), grantPaths(effect));
  const select: LensSelect = {};
  for (const [field, entry] of Object.entries(fields)) {
    const visible = mode !== 'paths' && isFieldVisible(effect, field);
    const below = own(paths, field);
    // A bridge is another source: nothing a Prisma select can open.
    if ((!visible && below === undefined) || entry.kind === 'bridge') continue;
    if (entry.kind !== 'object') {
      select[field] = true;
      continue;
    }
    if (mode === 'shallow' && below === undefined) continue;
    const childMode = visible ? openedMode(mode, effect, field) : 'paths';
    const child = childVisit(at, field, { mapName: at.mapName, modelName: entry.type });
    const childSelect = selectAt(policy, child, childMode, below ?? {}, options);
    const where =
      entry.isList && childMode !== 'paths'
        ? grantWhere(
            policy,
            child,
            resolveVisit(policy, child.mapName, child.modelName, child.relPath),
            options,
          )
        : undefined;
    // A relation that shows no column is fetched whole: Prisma can't select nothing.
    select[field] = Object.keys(childSelect).length
      ? { select: childSelect, ...(where && { where }) }
      : where
        ? { where }
        : true;
  }
  return select;
};

/**
 * Prisma `findMany` args for the rows a lens shows, at its base model: each projected path's
 * visible columns, the relations its declared paths open (a visible relation off them, its columns
 * only), and the columns every `where` on the way reads. A to-many relation carries its visit's
 * grants compiled as its `where`, so related rows come pre-narrowed; a to-one relation can't (Prisma
 * takes no `where` there), so `projectRows` drops one its grant hides. The root's own grants are the
 * query's `where`: `toPrisma(rule, { lens })`. Bridges are not selected. A relation grant that needs
 * a counting step throws.
 */
export const toLensSelect = (
  lensOrNarrowing: Lens | LensNarrowing,
  options: LensSelectOptions = {},
): { select: LensSelect } => {
  const policy = resolvePolicy(lensOrNarrowing);
  return { select: selectAt(policy, rootVisit(policy), 'declared', {}, options) };
};

// A relation's value, each related row through `cut`: a list keeps the rows it returns, a single
// row is what it returns (null when hidden).
const mapRelation = (value: unknown, cut: (row: Row) => Row | null): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value))
    return value.flatMap((row) => {
      const kept = typeof row === 'object' && row !== null ? cut(row as Row) : null;
      return kept === null ? [] : [kept];
    });
  return typeof value === 'object' ? cut(value as Row) : null;
};

// The paths in `tree`, copied from a row as they are — a grant's columns, under no visit of their own.
const pickPaths = (policy: Policy, at: MapVisit, row: Row, tree: PathTree): Row => {
  const out: Row = {};
  const model = modelOf(own(policy.lens.maps, at.mapName), at.modelName);
  for (const [field, below] of Object.entries(tree)) {
    if (!Object.hasOwn(row, field)) continue;
    const entry = own(model?.fields, field);
    const target = entry ? relationTargetOf(entry, at.mapName) : null;
    out[field] = target
      ? mapRelation(row[field], (r) => pickPaths(policy, childVisit(at, field, target), r, below))
      : row[field];
  }
  return out;
};

const cutRow = (
  policy: Policy,
  at: MapVisit,
  mode: Mode,
  row: Row,
  extra: PathTree,
  keepGrants: boolean,
  options: CheckOptions,
): Row | null => {
  const effect = resolveVisit(policy, at.mapName, at.modelName, at.relPath);
  if (!effect.whereClauses.every((where) => check(where, row, options) === true)) return null;
  const fields = modelOf(own(policy.lens.maps, at.mapName), at.modelName)?.fields ?? {};
  const keep = keepGrants ? addPaths(mergeTrees({}, extra), grantPaths(effect)) : {};
  const out: Row = {};
  for (const [field, entry] of Object.entries(fields)) {
    if (!Object.hasOwn(row, field)) continue;
    const visible = isFieldVisible(effect, field);
    const below = own(keep, field);
    const target = relationTargetOf(entry, at.mapName);
    if (!target) {
      if (visible || below !== undefined) out[field] = row[field];
      continue;
    }
    const child = childVisit(at, field, target);
    if (visible && mode === 'declared') {
      const childMode = openedMode(mode, effect, field);
      out[field] = mapRelation(row[field], (r) =>
        cutRow(policy, child, childMode, r, below ?? {}, keepGrants, options),
      );
    } else if (below !== undefined) {
      out[field] = mapRelation(row[field], (r) => pickPaths(policy, child, r, below));
    }
  }
  return out;
};

/**
 * Rows cut to what a lens shows, recursively from its base model: hidden columns and relations
 * removed, and every row a visit's `where` hides gone — a root or list row dropped, a to-one row
 * null. `keepGrantColumns` also keeps the columns those `where`s read (hidden or not), so a later
 * `check(narrowRule(rule, lens), row)` can re-test the grants. The rest of `options` is what each
 * `where` is checked with (`now`, `bindings`). Plain JSON in and out; the input is not mutated.
 */
export const projectRows = (
  lensOrNarrowing: Lens | LensNarrowing,
  rows: readonly Row[],
  { keepGrantColumns = false, ...options }: ProjectRowsOptions = {},
): Row[] => {
  const policy = resolvePolicy(lensOrNarrowing);
  const root = rootVisit(policy);
  return rows.flatMap((row) => {
    const kept = cutRow(policy, root, 'declared', row, {}, keepGrantColumns, options);
    return kept === null ? [] : [kept];
  });
};
