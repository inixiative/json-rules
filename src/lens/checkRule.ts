import type { Condition } from '../types';
import type { Policy } from './policy.ts';
import { allowedEnumValues, resolvePolicy, resolveVisit, walkLensPath } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

export type RuleLensViolation = {
  path: string;
  reason: string;
};

export type RuleLensCheck = {
  ok: boolean;
  violations: RuleLensViolation[];
};

// Extracts the leaf "value" from a rule for enum-value validation. Handles
// scalar value, array value (for in/notIn), and value via path-ref (skipped —
// we can't validate at compile time without context).
const extractEnumLiterals = (cond: {
  value?: unknown;
  path?: unknown;
  operator?: unknown;
}): readonly unknown[] | null => {
  if (cond.path !== undefined) return null; // runtime value — skip
  const v = cond.value;
  if (v === undefined) return null;
  if (Array.isArray(v)) return v;
  return [v];
};

const visit = (
  cond: Condition,
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
  violations: RuleLensViolation[],
): void => {
  if (typeof cond === 'boolean') return;

  if ('all' in cond) {
    for (const c of cond.all) visit(c, policy, mapName, modelName, relPath, violations);
    return;
  }
  if ('any' in cond) {
    for (const c of cond.any) visit(c, policy, mapName, modelName, relPath, violations);
    return;
  }
  if ('if' in cond) {
    visit(cond.if, policy, mapName, modelName, relPath, violations);
    visit(cond.then, policy, mapName, modelName, relPath, violations);
    if (cond.else !== undefined) visit(cond.else, policy, mapName, modelName, relPath, violations);
    return;
  }

  let nextMap = mapName;
  let nextModel = modelName;
  let nextRelPath = relPath;
  let terminalFieldName: string | null = null;
  let terminalIsEnum = false;
  let terminalEnumType: string | null = null;
  let terminalAllowedValues: readonly string[] | null = null;

  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const walked = walkLensPath(policy, mapName, modelName, relPath, cond.field);
    if (!walked) {
      violations.push({
        path: cond.field,
        reason: 'path does not resolve through the narrowed lens',
      });
      return;
    }
    terminalFieldName = walked.terminalFieldName;
    terminalIsEnum = walked.entry.kind === 'enum';
    terminalEnumType = walked.entry.type;
    terminalAllowedValues = allowedEnumValues(walked.terminalEffect, terminalFieldName);
    // Walk into the relation target for nested condition descent
    if (walked.entry.kind === 'object' || walked.entry.kind === 'bridge') {
      const target =
        walked.entry.kind === 'object'
          ? { mapName: walked.mapName, modelName: walked.entry.type }
          : {
              mapName: walked.entry.type.split(':')[0] ?? walked.mapName,
              modelName: walked.entry.type.split(':')[1] ?? walked.entry.type,
            };
      nextMap = target.mapName;
      nextModel = target.modelName;
      nextRelPath = [...walked.relPath, terminalFieldName];
    }
  }

  // Gate the RHS `path` ref the same way the LHS `field` is gated — otherwise a rule
  // can reference outside the lens through its comparison value. `$.`-prefixed paths are
  // current-element refs (resolve at the current anchor); bare paths are root/context refs
  // (resolve at the lens anchor).
  if ('path' in cond && typeof cond.path === 'string' && cond.path !== '') {
    const isCurrentElement = cond.path.startsWith('$.');
    const pathField = isCurrentElement ? cond.path.slice(2) : cond.path;
    const walkedPath = isCurrentElement
      ? walkLensPath(policy, mapName, modelName, relPath, pathField)
      : walkLensPath(policy, policy.lens.mapName, policy.lens.model, [], pathField);
    if (!walkedPath) {
      violations.push({
        path: cond.path,
        reason: 'path (comparison ref) does not resolve through the narrowed lens',
      });
    }
  }

  // Gate the window's `filter` (a full Condition over the array elements) and `orderBy`
  // field refs — both are evaluated against the descended relation target.
  if ('filter' in cond && cond.filter !== undefined) {
    visit(cond.filter as Condition, policy, nextMap, nextModel, nextRelPath, violations);
  }
  if ('orderBy' in cond && Array.isArray(cond.orderBy)) {
    for (const entry of cond.orderBy as { field?: unknown }[]) {
      if (entry && typeof entry.field === 'string' && entry.field !== '') {
        const walkedOrder = walkLensPath(policy, nextMap, nextModel, nextRelPath, entry.field);
        if (!walkedOrder) {
          violations.push({
            path: entry.field,
            reason: 'orderBy field does not resolve through the narrowed lens',
          });
        }
      }
    }
  }

  // Value-set validation for leaf rules. Fires whenever the field carries an
  // allowed set — an enum (registry/narrowed) or any other kind with explicit
  // `values`.
  if (terminalAllowedValues && 'operator' in cond && terminalFieldName) {
    const literals = extractEnumLiterals(
      cond as { value?: unknown; path?: unknown; operator?: unknown },
    );
    if (literals) {
      const allowed = new Set(terminalAllowedValues);
      const scope = terminalIsEnum ? `enum '${terminalEnumType}'` : `field '${terminalFieldName}'`;
      for (const v of literals) {
        if (typeof v === 'string' && !allowed.has(v)) {
          violations.push({
            path: terminalFieldName,
            reason: `value '${v}' is not in the allowed set for ${scope} (allowed: ${[...allowed].join(', ')})`,
          });
        }
      }
    }
  }

  // Aggregate sub-field
  if (
    'aggregate' in cond &&
    typeof cond.aggregate === 'object' &&
    cond.aggregate !== null &&
    typeof cond.aggregate.field === 'string' &&
    cond.aggregate.field !== ''
  ) {
    const aggField = cond.aggregate.field;
    const aggWalked = walkLensPath(policy, nextMap, nextModel, nextRelPath, aggField);
    if (!aggWalked) {
      violations.push({
        path: aggField,
        reason: 'aggregate.field does not resolve through the narrowed lens',
      });
    }
  }

  if ('condition' in cond && cond.condition !== undefined) {
    visit(cond.condition, policy, nextMap, nextModel, nextRelPath, violations);
  }
};

export const checkRuleAgainstLens = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): RuleLensCheck => {
  const policy = resolvePolicy(lensOrNarrowing);
  const violations: RuleLensViolation[] = [];
  visit(rule, policy, policy.lens.mapName, policy.lens.model, [], violations);
  // Quickly validate that root visit doesn't have issues either (touches resolveVisit for the side effect, but mainly to ensure policy resolves)
  resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);
  return { ok: violations.length === 0, violations };
};
