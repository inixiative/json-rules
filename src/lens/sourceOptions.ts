import type { SourceOption } from '../toPrisma/types.ts';
import type { Condition } from '../types.ts';
import { prefixConditionFields } from './applyLens.ts';
import { type Policy, resolveVisit } from './policy.ts';
import { resolveRelationTarget } from './walk.ts';

type Row = Record<string, unknown>;

// gloss
const foldPathGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  dotted: string,
  strict: boolean,
  seen: Set<string>,
  out: Condition[],
): void => {
  const segments = dotted.split('.');
  let curMap = mapName;
  let curModel = modelName;
  const relPath = [...baseRelPath];
  for (let i = 0; i < segments.length - 1; i++) {
    const entry = policy.lens.maps[curMap]?.models[curModel]?.fields[segments[i]];
    const target = entry ? resolveRelationTarget(entry, curMap) : null;
    if (!target) {
      if (strict) {
        throw new Error(
          `groupBy '${dotted}': hop '${segments[i]}' is not a resolvable relation on '${curModel}' — cannot guard its join`,
        );
      }
      return;
    }
    relPath.push(segments[i]);
    curMap = target.mapName;
    curModel = target.modelName;
    const hopKey = relPath.join('.');
    if (seen.has(hopKey)) continue;
    seen.add(hopKey);
    const effect = resolveVisit(policy, curMap, curModel, relPath);
    const prefix = segments.slice(0, i + 1).join('.');
    for (const where of effect.whereClauses) out.push(prefixConditionFields(where, prefix));
  }
};

// gloss
const collectFieldPaths = (condition: Condition, out: string[] = []): string[] => {
  if (typeof condition !== 'object' || condition === null) return out;
  const c = condition as Record<string, unknown>;
  if (Array.isArray(c.all)) for (const child of c.all as Condition[]) collectFieldPaths(child, out);
  if (Array.isArray(c.any)) for (const child of c.any as Condition[]) collectFieldPaths(child, out);
  if (c.if !== undefined) {
    collectFieldPaths(c.if as Condition, out);
    collectFieldPaths(c.then as Condition, out);
    if (c.else !== undefined) collectFieldPaths(c.else as Condition, out);
  }
  if (typeof c.field === 'string') out.push(c.field);
  return out;
};

// gloss
export const traversalGuards = (
  policy: Policy,
  mapName: string,
  modelName: string,
  baseRelPath: readonly string[],
  axes: readonly string[],
  whereClauses: readonly Condition[],
): Condition[] => {
  const out: Condition[] = [];
  const seen = new Set<string>();
  for (const axis of axes)
    foldPathGuards(policy, mapName, modelName, baseRelPath, axis, true, seen, out);
  for (const clause of whereClauses) {
    for (const path of collectFieldPaths(clause)) {
      if (path.includes('.'))
        foldPathGuards(policy, mapName, modelName, baseRelPath, path, false, seen, out);
    }
  }
  return out;
};

// gloss
export const groupAtPath = (row: Row, path: string): string | undefined => {
  let cur: unknown = row;
  for (const segment of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Row)[segment];
  }
  return cur == null || typeof cur === 'object' ? undefined : String(cur);
};

// gloss
export const groupsAtPaths = (row: Row, paths: readonly string[]): string[] | undefined => {
  const out: string[] = [];
  for (const path of paths) {
    const value = groupAtPath(row, path);
    if (value === undefined) return undefined;
    out.push(value);
  }
  return out;
};

// gloss
export const optionKey = (groups: readonly string[] | undefined, value: string): string =>
  JSON.stringify([groups ?? null, value]);

// gloss
export const accumulateOption = (
  byKey: Map<string, SourceOption>,
  value: string,
  label: string | undefined,
  groups: string[] | undefined,
): void => {
  const key = optionKey(groups, value);
  const existing = byKey.get(key);
  if (existing === undefined) {
    byKey.set(key, {
      value,
      ...(label !== undefined ? { label } : {}),
      ...(groups !== undefined ? { groups } : {}),
    });
  } else if (existing.label === undefined && label !== undefined) {
    byKey.set(key, { ...existing, label });
  }
};

// gloss
export const sortOptions = (byKey: Map<string, SourceOption>): SourceOption[] =>
  [...byKey.values()].sort((a, b) => {
    const tier = (a.groups === undefined ? 0 : 1) - (b.groups === undefined ? 0 : 1);
    if (tier !== 0) return tier;
    const ga = a.groups ?? [];
    const gb = b.groups ?? [];
    for (let i = 0; i < Math.max(ga.length, gb.length); i++) {
      const cmp = (ga[i] ?? '').localeCompare(gb[i] ?? '', 'en', { numeric: true });
      if (cmp !== 0) return cmp;
    }
    return (a.label ?? a.value).localeCompare(b.label ?? b.value, 'en', { numeric: true });
  });
