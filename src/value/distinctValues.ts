/** Whether a list asks for its repeats dropped: `{ list, distinct: true }`. */
export const isDistinct = (expr: unknown): boolean =>
  !Array.isArray(expr) && (expr as { distinct?: unknown }).distinct === true;

/** Per-kind equality key for a value: dates by instant, other objects (Decimal, Bytes) by JSON,
 *  primitives by type and value (`caseInsensitive` folds strings). No two kinds collide (`1` and
 *  `Decimal('1')` and `'1'` stay distinct). */
export const distinctKey = (value: unknown, caseInsensitive = false): string => {
  if (value instanceof Date) return `d:${value.getTime()}`;
  if (typeof value === 'object' && value !== null) return `o:${JSON.stringify(value)}`;
  const normalized = caseInsensitive && typeof value === 'string' ? value.toLowerCase() : value;
  return `p:${typeof value}:${String(normalized)}`;
};

/** A list's values without repeats, keeping the first of equal items. A scalar is its own key
 *  (a string lowered when `caseInsensitive`); a date is keyed by its instant and any other object
 *  (a Decimal, Bytes) by its JSON, each in its own set so no two kinds compare equal: `1` and
 *  `Decimal('1')` are two values. Json is refused at save (inferValueType). */
export const distinctValues = (values: unknown[], caseInsensitive = false): unknown[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = distinctKey(value, caseInsensitive);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** Tuples of values without repeats, keeping the first of equal tuples (element-wise per-kind
 *  equality via `distinctKey`, JSON-framed so NUL bytes in strings never collide). */
export const distinctTuples = (tuples: unknown[][]): unknown[][] => {
  const seen = new Set<string>();
  return tuples.filter((tuple) => {
    const key = JSON.stringify(tuple.map((value) => distinctKey(value)));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
