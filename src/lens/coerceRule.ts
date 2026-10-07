import { isRelationEntry } from '../fieldMap/entry.ts';
import { COERCIBLE_KINDS, type FieldKind } from '../operatorCatalog.ts';
import { conditionShape, isRelationNode, mapCondition } from '../traverse';
import type { Condition } from '../types.ts';
import { lensRootScope, resolvePolicy, stepIntoField, type VisitScope } from './policy.ts';
import type { Lens, LensNarrowing } from './types.ts';

// Stamp coerceType onto every field rule from the lens's field map — the explicit dual of the
// server's coerceValueForField: the rule carries its coercion, check() never infers types from
// values. A relation node's condition / filter stamp against the relation's model; below a Json
// boundary the kind is undeclared, so nothing is stamped. A date rule, an aggregate comparison
// (numeric by contract) and a rule that already names its coercion are left as they are.
export const coerceRule = (
  condition: Condition,
  lensOrNarrowing: Lens | LensNarrowing,
): Condition => {
  const policy = resolvePolicy(lensOrNarrowing);
  const step = (field: unknown, scopes: readonly VisitScope[]) =>
    typeof field === 'string' && field !== '' ? stepIntoField(policy, scopes, field) : null;
  return mapCondition<readonly VisitScope[]>(
    condition,
    {
      rewrite: (node, scopes) => {
        if (conditionShape(node) !== 'field' || node.coerceType) return node;
        const at = step(node.field, scopes);
        if (!at || 'issue' in at || !at.walked || at.walked.jsonSubPath.length) return node;
        const { entry } = at.walked;
        return entry.kind === 'scalar' && COERCIBLE_KINDS.includes(entry.type as FieldKind)
          ? { ...node, coerceType: entry.type }
          : node;
      },
      below: (node, scopes) => {
        if (!isRelationNode(node)) return false;
        const at = step(node.field, scopes);
        const entry = at && !('issue' in at) ? at.walked?.entry : undefined;
        return at && !('issue' in at) && entry && isRelationEntry(entry)
          ? [...scopes, at.next]
          : false;
      },
    },
    [lensRootScope(policy)],
  );
};
