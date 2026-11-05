/** Whether a list asks for its repeats dropped: `{ list, distinct: true }`. */
export const isDistinct = (expr: unknown): boolean =>
  !Array.isArray(expr) && (expr as { distinct?: unknown }).distinct === true;

/** A list's values without repeats, keeping the first of equal items. A scalar is its own key
 *  (a string lowered when `caseInsensitive`); a date is keyed by its instant and any other object
 *  (a Decimal, Bytes) by its JSON, each in its own set so no two kinds compare equal: `1` and
 *  `Decimal('1')` are two values. Json is refused at save (inferValueType). */
export const distinctValues = (values: unknown[], caseInsensitive = false): unknown[] => {
  const scalars = new Set<unknown>();
  const dates = new Set<number>();
  const objects = new Set<string>();
  return values.filter((value) => {
    const [seen, key]: [Set<unknown>, unknown] =
      value instanceof Date
        ? [dates, value.getTime()]
        : typeof value === 'object' && value !== null
          ? [objects, JSON.stringify(value)]
          : [scalars, caseInsensitive && typeof value === 'string' ? value.toLowerCase() : value];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
