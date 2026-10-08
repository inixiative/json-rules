/**
 * The plan's own references — a `{ __step }` (a groupBy step's result) or a `{ __field }` (a
 * column reference) — are objects this compile emitted, and the plan records where each sits.
 * `executePrismaPlan` resolves those locations only: a rule value shaped like one is data, never a
 * reference, and the compile refuses it outright.
 */

/** Where a step's where (or groupBy args) holds a reference: the keys down to it. */
export type SentinelRef = { path: (string | number)[] };

const EMITTED = new WeakSet<object>();

/** A reference this compile emits. */
export const emit = <T extends object>(sentinel: T): T => {
  EMITTED.add(sentinel);
  return sentinel;
};

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** The locations of the references this compile emitted inside `root`. */
export const recordRefs = (root: unknown): SentinelRef[] => {
  const refs: SentinelRef[] = [];
  const walk = (at: unknown, path: (string | number)[]): void => {
    if (at !== null && typeof at === 'object' && EMITTED.has(at)) {
      refs.push({ path });
      return;
    }
    if (Array.isArray(at)) {
      for (const [i, item] of at.entries()) walk(item, [...path, i]);
    } else if (isPlain(at))
      for (const [key, value] of Object.entries(at)) walk(value, [...path, key]);
  };
  walk(root, []);
  return refs;
};

const RESERVED = ['__step', '__field'];

/** A value holding an own `__step` / `__field` key anywhere: reserved for the plan's references. */
export const holdsReservedKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(holdsReservedKey);
  if (!isPlain(value)) return false;
  return Object.entries(value).some(
    ([key, inner]) => RESERVED.includes(key) || holdsReservedKey(inner),
  );
};
