import { parseScopeRef, resolveScopeRef } from '../scope';
import type { Condition } from '../types';
import type { Policy } from './policy.ts';
import { allowedEnumValues, resolvePolicy, resolveVisit, walkLensPath } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';
import { isJsonEntry } from './walk.ts';

export type RuleLensViolation = {
  path: string;
  reason: string;
};

export type RuleLensCheck = {
  ok: boolean;
  violations: RuleLensViolation[];
};

type VisitScope = {
  mapName: string;
  modelName: string;
  relPath: readonly string[];
  open: boolean;
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

const lensRoot = (policy: Policy): VisitScope => ({
  mapName: policy.lens.mapName,
  modelName: policy.lens.model,
  relPath: [],
  open: false,
});

const visit = (
  cond: Condition,
  policy: Policy,
  scopes: readonly VisitScope[],
  violations: RuleLensViolation[],
): void => {
  if (typeof cond === 'boolean') return;

  if ('all' in cond) {
    for (const c of cond.all) visit(c, policy, scopes, violations);
    return;
  }
  if ('any' in cond) {
    for (const c of cond.any) visit(c, policy, scopes, violations);
    return;
  }
  if ('if' in cond) {
    visit(cond.if, policy, scopes, violations);
    visit(cond.then, policy, scopes, violations);
    if (cond.else !== undefined) visit(cond.else, policy, scopes, violations);
    return;
  }

  const here = scopes[scopes.length - 1];

  // A bare ref resolves at the current visit; `$`-prefixed refs count scopes up the stack
  // (`$.` = current element, `$$.` = its enclosing element, …) exactly as check() does.
  const scopeFor = (ref: string): { scope: VisitScope; field: string } | null => {
    const target = resolveScopeRef(ref, scopes);
    if ('outOfBounds' in target) {
      violations.push({ path: ref, reason: target.outOfBounds });
      return null;
    }
    return { scope: target.scope, field: target.path };
  };

  let next: VisitScope = here;
  let fieldOk = true;
  let terminalFieldName: string | null = null;
  let terminalIsEnum = false;
  let terminalEnumType: string | null = null;
  let terminalAllowedValues: readonly string[] | null = null;

  if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
    const target = scopeFor(cond.field);
    if (!target) {
      fieldOk = false;
    } else if (target.scope.open) {
      // A Json column's elements/members are undeclared — nothing to gate, stay open.
      next = target.scope;
    } else {
      const { mapName, modelName, relPath } = target.scope;
      const walked = walkLensPath(policy, mapName, modelName, relPath, target.field);
      if (!walked) {
        violations.push({
          path: cond.field,
          reason: 'path does not resolve through the narrowed lens',
        });
        fieldOk = false;
      } else {
        terminalFieldName = walked.terminalFieldName;
        terminalIsEnum = walked.entry.kind === 'enum';
        terminalEnumType = walked.entry.type;
        // Below a Json boundary the value is undeclared, so the column's own allowed set
        // says nothing about it — only gate a path that ends ON the declared entry.
        terminalAllowedValues =
          walked.jsonSubPath.length > 0
            ? null
            : allowedEnumValues(walked.terminalEffect, terminalFieldName);
        const open = isJsonEntry(walked.entry);
        if (walked.entry.kind === 'object' || walked.entry.kind === 'bridge') {
          const relation =
            walked.entry.kind === 'object'
              ? { mapName: walked.mapName, modelName: walked.entry.type }
              : {
                  mapName: walked.entry.type.split(':')[0] ?? walked.mapName,
                  modelName: walked.entry.type.split(':')[1] ?? walked.entry.type,
                };
          next = { ...relation, relPath: [...walked.relPath, terminalFieldName], open };
        } else {
          next = { ...target.scope, open };
        }
      }
    }
  }

  // Gate the RHS `path` ref the same way the LHS `field` is gated — otherwise a rule
  // can reference outside the lens through its comparison value. Prefixed paths resolve
  // at the scope they name; bare paths are root/context refs (resolve at the lens anchor).
  // Inside an open scope a prefixed ref points into the JSON value, so there is nothing to
  // resolve — a root ref is still gated.
  if ('path' in cond && typeof cond.path === 'string' && cond.path !== '') {
    const target = parseScopeRef(cond.path)
      ? scopeFor(cond.path)
      : { scope: lensRoot(policy), field: cond.path };
    if (target && !target.scope.open) {
      const { mapName, modelName, relPath } = target.scope;
      if (!walkLensPath(policy, mapName, modelName, relPath, target.field)) {
        violations.push({
          path: cond.path,
          reason: 'path (comparison ref) does not resolve through the narrowed lens',
        });
      }
    }
  }

  if (!fieldOk) return;

  const below = [...scopes, next];

  // Gate the window's `filter` (a full Condition over the array elements) and `orderBy`
  // field refs — both are evaluated against the descended relation target.
  if ('filter' in cond && cond.filter !== undefined) {
    visit(cond.filter as Condition, policy, below, violations);
  }
  if (!next.open && 'orderBy' in cond && Array.isArray(cond.orderBy)) {
    for (const entry of cond.orderBy as { field?: unknown }[]) {
      if (entry && typeof entry.field === 'string' && entry.field !== '') {
        const walkedOrder = walkLensPath(
          policy,
          next.mapName,
          next.modelName,
          next.relPath,
          entry.field,
        );
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
    !next.open &&
    'aggregate' in cond &&
    typeof cond.aggregate === 'object' &&
    cond.aggregate !== null &&
    typeof cond.aggregate.field === 'string' &&
    cond.aggregate.field !== ''
  ) {
    const aggField = cond.aggregate.field;
    const aggWalked = walkLensPath(policy, next.mapName, next.modelName, next.relPath, aggField);
    if (!aggWalked) {
      violations.push({
        path: aggField,
        reason: 'aggregate.field does not resolve through the narrowed lens',
      });
    }
  }

  if ('condition' in cond && cond.condition !== undefined) {
    visit(cond.condition, policy, below, violations);
  }
};

/**
 * Gate a condition whose `field` refs are relative to the visit (mapName, modelName, relPath)
 * of `policy` — the shape of a narrowing `where` anchored at a relation node or a model
 * default. The policy keeps its real anchor, so a bare `path` ref still resolves at the lens
 * root (check()'s root context) and a `$.` ref at the visit. Internal to the lens layer.
 */
export const checkConditionAtVisit = (
  cond: Condition,
  policy: Policy,
  mapName: string,
  modelName: string,
  relPath: readonly string[],
): RuleLensViolation[] => {
  const violations: RuleLensViolation[] = [];
  visit(cond, policy, [{ mapName, modelName, relPath, open: false }], violations);
  return violations;
};

export const checkRuleAgainstLens = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): RuleLensCheck => {
  const policy = resolvePolicy(lensOrNarrowing);
  const violations = checkConditionAtVisit(
    rule,
    policy,
    policy.lens.mapName,
    policy.lens.model,
    [],
  );
  // Quickly validate that root visit doesn't have issues either (touches resolveVisit for the side effect, but mainly to ensure policy resolves)
  resolveVisit(policy, policy.lens.mapName, policy.lens.model, []);
  return { ok: violations.length === 0, violations };
};
