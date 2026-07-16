import type { SourceOption } from '../toPrisma/types.ts';

type Row = Record<string, unknown>;

/** Walk a dotted to-one path through nested row objects; undefined when unreachable. */
export const groupAtPath = (row: Row, path: string): string | undefined => {
  let cur: unknown = row;
  for (const segment of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[segment];
  }
  return cur == null || typeof cur === 'object' ? undefined : String(cur);
};

/** Dedup key — options are unique per (group, value), not per value. */
export const optionKey = (group: string | undefined, value: string): string =>
  JSON.stringify([group ?? null, value]);

/** Merge one occurrence into the accumulator; the first non-null label wins. */
export const accumulateOption = (
  byKey: Map<string, SourceOption>,
  value: string,
  label: string | undefined,
  group: string | undefined,
): void => {
  const key = optionKey(group, value);
  const existing = byKey.get(key);
  if (existing === undefined) {
    byKey.set(key, {
      value,
      ...(label !== undefined ? { label } : {}),
      ...(group !== undefined ? { group } : {}),
    });
  } else if (existing.label === undefined && label !== undefined) {
    byKey.set(key, { ...existing, label });
  }
};

// Fixed locale: host-locale sorting would make option order machine-dependent.
export const sortOptions = (byKey: Map<string, SourceOption>): SourceOption[] =>
  [...byKey.values()].sort((a, b) => {
    const byGroup = (a.group ?? '').localeCompare(b.group ?? '', 'en', { numeric: true });
    if (byGroup !== 0) return byGroup;
    return (a.label ?? a.value).localeCompare(b.label ?? b.value, 'en', { numeric: true });
  });
