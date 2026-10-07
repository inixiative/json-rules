import { INTEGER_KINDS, NUMERIC_KINDS } from '../operatorCatalog';
import { parseScopeRef, readScopeRef } from '../scope';
import { entryKind } from '../toPrisma/mapWalk';
import type { FieldMapEntry } from '../toPrisma/types.ts';
import { isLogicalNode, valueRefRoles, visitCondition } from '../traverse';
import type { Condition } from '../types';
import { type ValidationIssue, type ValidationResult, validationResult } from '../validate';
import { arrayFitViolation, leafFitViolations, ruleLiterals } from './fieldFit.ts';
import type { Policy } from './policy.ts';
import {
  allowedEnumValues,
  type LensWalk,
  lensPathEnd,
  lensRootScope,
  resolvePolicy,
  stepIntoField,
  type VisitScope,
} from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

const visit = (
  rule: Condition,
  policy: Policy,
  root: VisitScope,
  violations: ValidationIssue[],
): void =>
  visitCondition<readonly VisitScope[]>(
    rule,
    (node, scopes) => {
      if (isLogicalNode(node)) {
        // A node that is both logical and a leaf evaluates as one or the other depending on the
        // rail; the gate refuses it rather than vouch for half of it.
        if ('field' in node)
          violations.push({
            path: String(node.field),
            code: 'ambiguous_condition',
            message: 'a condition is either logical (all / any / if) or a leaf, not both',
          });
        return;
      }
      const cond = node as unknown as Exclude<Condition, boolean>;

      // A bare ref resolves at the current visit; `$`-prefixed refs count scopes up the stack.
      const scopeFor = (ref: string): { scope: VisitScope; field: string } | null => {
        const target = readScopeRef(ref, scopes);
        if ('outOfBounds' in target) {
          violations.push({ path: ref, code: 'scope_out_of_bounds', message: target.outOfBounds });
          return null;
        }
        return { scope: target.scope, field: target.path };
      };

      let next: VisitScope = scopes[scopes.length - 1];
      let fieldOk = true;
      let walked: LensWalk | null = null;
      if ('field' in cond && typeof cond.field === 'string' && cond.field !== '') {
        const step = stepIntoField(policy, scopes, cond.field);
        if ('violation' in step) {
          violations.push({
            path: cond.field,
            code: step.violation.startsWith('Scope ref') ? 'scope_out_of_bounds' : 'not_in_lens',
            message: step.violation,
          });
          fieldOk = false;
        } else {
          ({ next, walked } = step);
        }
      }
      const terminalEntry: FieldMapEntry | null = walked?.entry ?? null;
      const terminalFieldName = walked?.terminalFieldName ?? null;
      const terminalIsEnum = walked?.entry.kind === 'enum';
      const terminalEnumType = walked?.entry.type ?? null;
      // Below a Json boundary the value is undeclared, so the column's own allowed set says
      // nothing about it — only gate a path that ends ON the declared entry.
      const terminalAllowedValues =
        walked && walked.jsonSubPath.length === 0
          ? allowedEnumValues(walked.terminalEffect, walked.terminalFieldName)
          : null;

      // Gate every value-side ref — the RHS `path`, an offset `{ path }`, each magnitude `{ path }` —
      // the same way the LHS `field` is gated; otherwise a rule can reference outside the lens
      // through its comparison value. Prefixed refs resolve at the scope they name; bare refs are
      // root/context refs (resolve at the lens anchor). Inside an open scope a prefixed ref points
      // into the JSON value, so there is nothing to resolve — a root ref is still gated. An amount
      // reads a number, and a calendar unit's amount a whole number.
      for (const { ref, role } of valueRefRoles(cond as Record<string, unknown>)) {
        const target = parseScopeRef(ref)
          ? scopeFor(ref)
          : { scope: lensRootScope(policy), field: ref };
        if (!target || target.scope.open) continue;
        const { mapName, modelName, relPath } = target.scope;
        const walked = lensPathEnd(policy, mapName, modelName, relPath, target.field);
        if (!walked) {
          violations.push({
            path: ref,
            code: 'not_in_lens',
            message:
              role === 'value'
                ? 'path (comparison ref) does not resolve through the narrowed lens'
                : 'offset or magnitude ref does not resolve through the narrowed lens',
          });
          continue;
        }
        const kind = entryKind(walked.entry);
        if (role === 'value' || role === 'shift' || kind === undefined) continue;
        const fits = role === 'whole' ? INTEGER_KINDS.includes(kind) : NUMERIC_KINDS.includes(kind);
        if (!fits)
          violations.push({
            path: ref,
            code: 'not_in_lens',
            message: `${role === 'whole' ? 'a calendar unit reads a whole number' : 'an offset or magnitude reads a number'}, not ${kind}`,
          });
      }

      if (!fieldOk) return false;

      // An array operator iterates its field. On a non-list the node cannot evaluate, and its
      // `condition`/`filter` have no element scope to resolve against — report it and stop.
      if ('arrayOperator' in cond && typeof cond.field === 'string' && terminalEntry) {
        const misfit = arrayFitViolation(cond.field, cond.arrayOperator, terminalEntry);
        if (misfit) {
          violations.push(misfit);
          return false;
        }
      }

      // Operator and literal against the field's kind (an aggregate's operator compares the
      // aggregate, not the field).
      // A scalar list's elements carry the kind (a stamp names it), but its operators test the list.
      if (
        !('aggregate' in cond) &&
        !terminalEntry?.isList &&
        ('operator' in cond || 'dateOperator' in cond)
      ) {
        violations.push(
          ...leafFitViolations(cond, terminalEntry ? entryKind(terminalEntry) : undefined),
        );
      }

      if (!next.open && 'orderBy' in cond && Array.isArray(cond.orderBy)) {
        for (const entry of cond.orderBy as { field?: unknown }[]) {
          if (entry && typeof entry.field === 'string' && entry.field !== '') {
            const walkedOrder = lensPathEnd(
              policy,
              next.mapName,
              next.modelName,
              next.relPath,
              entry.field,
            );
            if (!walkedOrder) {
              violations.push({
                path: entry.field,
                code: 'not_in_lens',
                message: 'orderBy field does not resolve through the narrowed lens',
              });
            }
          }
        }
      }

      // Value-set validation for leaf rules. Fires whenever the field carries an
      // allowed set — an enum (registry/narrowed) or any other kind with explicit
      // `values`.
      if (terminalAllowedValues && 'operator' in cond && terminalFieldName) {
        const literals = ruleLiterals(cond as { value?: unknown; path?: unknown });
        if (literals) {
          const allowed = new Set(terminalAllowedValues);
          const scope = terminalIsEnum
            ? `enum '${terminalEnumType}'`
            : `field '${terminalFieldName}'`;
          for (const v of literals) {
            if (typeof v === 'string' && !allowed.has(v)) {
              violations.push({
                path: terminalFieldName,
                code: 'value_not_allowed',
                message: `value '${v}' is not in the allowed set for ${scope} (allowed: ${[...allowed].join(', ')})`,
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
        const aggWalked = lensPathEnd(policy, next.mapName, next.modelName, next.relPath, aggField);
        if (!aggWalked) {
          violations.push({
            path: aggField,
            code: 'not_in_lens',
            message: 'aggregate.field does not resolve through the narrowed lens',
          });
        }
      }

      return [...scopes, next];
    },
    [root],
  );

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
): ValidationIssue[] => {
  const violations: ValidationIssue[] = [];
  visit(cond, policy, { mapName, modelName, relPath, open: false }, violations);
  return violations;
};

/** Gate a rule against a lens: every field and value-side ref resolves through it, and every
 *  operator, value and amount fits the field it reaches. */
export const validateRuleInLens = (
  rule: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): ValidationResult => {
  const policy = resolvePolicy(lensOrNarrowing);
  return validationResult(
    checkConditionAtVisit(rule, policy, policy.lens.mapName, policy.lens.model, []),
  );
};
