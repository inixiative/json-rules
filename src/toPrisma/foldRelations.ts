import type { FieldMap } from '../fieldMap/types';
import { fieldOf } from '../own';
import { andWhere } from './logical';
import type { PrismaWhere } from './types';

/**
 * A compiled where with its sibling filters on one to-one relation folded into one filter object.
 *
 * Prisma emits a join per relation-filter object, so `{ AND: [{ rel: A }, { rel: B }] }` joins
 * `rel` twice — and a lens clamp, a scope and the rule's own leaf each bring their own. A to-one
 * relation has at most one row, so the two read the same row and `{ rel: { AND: [A, B] } }` is the
 * same filter: both require the row, and both hold on it. The fold recurses into the folded
 * relation, OR arms, NOT and to-many filters, and never folds across them: two `some` filters can
 * be met by different rows, and an OR arm is not a conjunct.
 *
 * An OR arm that asks for a relation to be absent (`{ rel: { is: null } }`, or a deeper hop's
 * `{ rel: { hop: { is: null } } }`) beside a sibling that requires it present can never hold —
 * the AND fails on that row either way — so it drops out, and an OR left with one arm is that arm.
 * An OR whose every arm would drop is left as it is.
 *
 * Only a relation the map declares to-one folds; without a map nothing does. A filter with no
 * conjuncts (which Prisma may read as no constraint), `is: null` and `isNot` stay where they are.
 * A where with nothing to fold comes back as the same object.
 */
export const foldRelationFilters = (
  where: PrismaWhere,
  map: FieldMap | undefined,
  model: string | undefined,
): PrismaWhere => (map && model ? foldAt(where, map, model) : where);

type Relation = { key: string; isForm: boolean; inner: PrismaWhere };

const isObject = (value: unknown): value is PrismaWhere =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toOneTarget = (map: FieldMap, model: string, key: string): string | null => {
  const entry = fieldOf(map, model, key);
  return entry?.kind === 'object' && !entry.isList ? entry.type : null;
};

const TO_MANY: readonly string[] = ['some', 'every', 'none'];

// A where as the list of its conjuncts: one per key, an AND's own conjuncts flattened in.
const conjunctsOf = (where: PrismaWhere): PrismaWhere[] =>
  Object.entries(where).flatMap(([key, value]) => {
    if (key !== 'AND') return [{ [key]: value }];
    const arms = Array.isArray(value) ? value : [value];
    return arms.flatMap((arm) => (isObject(arm) ? conjunctsOf(arm) : [{ AND: arm }]));
  });

// A single-key conjunct filtering a to-one relation to a row that is there: its bare form with at
// least one conjunct, or `is` with a filter.
const asRelation = (conjunct: PrismaWhere, map: FieldMap, model: string): Relation | null => {
  const keys = Object.keys(conjunct);
  if (keys.length !== 1 || !toOneTarget(map, model, keys[0])) return null;
  const value = conjunct[keys[0]];
  if (!isObject(value)) return null;
  const valueKeys = Object.keys(value);
  if (valueKeys.includes('isNot')) return null;
  if (valueKeys.includes('is'))
    return valueKeys.length === 1 && isObject(value.is)
      ? { key: keys[0], isForm: true, inner: value.is }
      : null;
  return conjunctsOf(value).length ? { key: keys[0], isForm: false, inner: value } : null;
};

// The relation paths a conjunct requires to be there: a to-one filter's relation, and every path
// its own conjuncts require below it.
const requiredPaths = (conjunct: PrismaWhere, map: FieldMap, model: string): string[] => {
  const relation = asRelation(conjunct, map, model);
  if (!relation) return [];
  const target = toOneTarget(map, model, relation.key) as string;
  return [
    relation.key,
    ...conjunctsOf(relation.inner).flatMap((inner) =>
      requiredPaths(inner, map, target).map((path) => `${relation.key}.${path}`),
    ),
  ];
};

// The relation path an OR arm asks to be absent: a chain of to-one filters ending in `is: null`.
const absentPath = (arm: unknown, map: FieldMap, model: string): string | null => {
  if (!isObject(arm)) return null;
  const keys = Object.keys(arm);
  if (keys.length !== 1) return null;
  const target = toOneTarget(map, model, keys[0]);
  const value = arm[keys[0]];
  if (!target || !isObject(value)) return null;
  const valueKeys = Object.keys(value);
  if (valueKeys.length === 1 && valueKeys[0] === 'is' && value.is === null) return keys[0];
  const deeper = absentPath(value, map, target);
  return deeper ? `${keys[0]}.${deeper}` : null;
};

const foldList = (value: unknown[], map: FieldMap, model: string): unknown[] => {
  const next = value.map((arm) => (isObject(arm) ? foldAt(arm, map, model) : arm));
  return next.some((arm, i) => arm !== value[i]) ? next : value;
};

// Each entry of an object mapped — the same object when no entry changes.
const mapEntries = (
  where: PrismaWhere,
  fn: (key: string, value: unknown) => unknown,
): PrismaWhere => {
  let changed = false;
  const out: PrismaWhere = {};
  for (const [key, value] of Object.entries(where)) {
    out[key] = fn(key, value);
    if (out[key] !== value) changed = true;
  }
  return changed ? out : where;
};

const foldChild = (key: string, value: unknown, map: FieldMap, model: string): unknown => {
  if (key === 'AND' || key === 'OR' || key === 'NOT') {
    if (Array.isArray(value)) return foldList(value, map, model);
    return isObject(value) ? foldAt(value, map, model) : value;
  }
  const entry = fieldOf(map, model, key);
  if (entry?.kind !== 'object' || !isObject(value)) return value;
  if (entry.isList)
    return mapEntries(value, (op, inner) =>
      TO_MANY.includes(op) && isObject(inner) ? foldAt(inner, map, entry.type) : inner,
    );
  const keys = Object.keys(value);
  if (keys.length === 1 && (keys[0] === 'is' || keys[0] === 'isNot'))
    return mapEntries(value, (_, inner) =>
      isObject(inner) ? foldAt(inner, map, entry.type) : inner,
    );
  return foldAt(value, map, entry.type);
};

// Each of a where's children folded at the model it reads.
const foldChildren = (where: PrismaWhere, map: FieldMap, model: string): PrismaWhere =>
  mapEntries(where, (key, value) => foldChild(key, value, map, model));

// An OR conjunct's dead arms dropped, given the paths its siblings require: null when none drops,
// or when every arm would.
const pruneOr = (
  conjunct: PrismaWhere,
  present: Set<string>,
  map: FieldMap,
  model: string,
): PrismaWhere[] | null => {
  const keys = Object.keys(conjunct);
  if (keys.length !== 1 || keys[0] !== 'OR' || !Array.isArray(conjunct.OR)) return null;
  const arms = conjunct.OR as unknown[];
  const live = arms.filter((arm) => {
    const path = absentPath(arm, map, model);
    return path === null || !present.has(path);
  });
  if (live.length === arms.length || live.length === 0) return null;
  return live.length === 1 && isObject(live[0]) ? conjunctsOf(live[0]) : [{ OR: live }];
};

const foldAt = (where: PrismaWhere, map: FieldMap, model: string): PrismaWhere => {
  let conjuncts = conjunctsOf(where);

  // Dead arms first: an OR that drops to one arm becomes a conjunct that may fold, and may itself
  // require a path another OR's arm asks to be absent.
  let pruned = false;
  for (let again = true; again; ) {
    again = false;
    const present = new Set(conjuncts.flatMap((c) => requiredPaths(c, map, model)));
    conjuncts = conjuncts.flatMap((conjunct) => {
      const kept = pruneOr(conjunct, present, map, model);
      if (!kept) return [conjunct];
      again = pruned = true;
      return kept;
    });
  }

  const groups = new Map<string, Relation[]>();
  for (const conjunct of conjuncts) {
    const relation = asRelation(conjunct, map, model);
    if (relation) groups.set(relation.key, [...(groups.get(relation.key) ?? []), relation]);
  }
  if (!pruned && ![...groups.values()].some((group) => group.length > 1))
    return foldChildren(where, map, model);

  const folded = new Set<string>();
  const out: PrismaWhere[] = [];
  for (const conjunct of conjuncts) {
    const relation = asRelation(conjunct, map, model);
    const group = relation ? (groups.get(relation.key) ?? []) : [];
    if (!relation || group.length < 2) {
      out.push(foldChildren(conjunct, map, model));
      continue;
    }
    // The group lands where its first member stood.
    if (folded.has(relation.key)) continue;
    folded.add(relation.key);
    const target = toOneTarget(map, model, relation.key) as string;
    const inner = foldAt(andWhere(group.map((member) => member.inner)), map, target);
    out.push({ [relation.key]: group.some((member) => member.isForm) ? { is: inner } : inner });
  }
  return andWhere(out);
};
