import { parseScopeRef, readScopeRef } from '../scope';
import { elementRefs, isLogicalNode, isRelationNode, valueRefs, visitCondition } from '../traverse';
import type { Condition } from '../types';

const joinPath = (prefix: string, path: string): string =>
  prefix === '' ? path : path === '' ? prefix : `${prefix}.${path}`;

/**
 * The dotted paths a lens `where` reads from the row it is checked against — its fields, the value
 * side's paths, and each relation node's `orderBy` / `aggregate.field` — as `check(where, row)`
 * reads them: a relation node's `condition` / `filter` under its field, `$` refs up the relation
 * scopes, a bare value `path` from the row. Internal: the lens reads its own clamps with it.
 */
export const readPaths = (condition: Condition): string[] => {
  const found = new Set<string>();
  const add = (path: string | null): void => {
    if (path) found.add(path);
  };
  const absolute = (ref: string, scopes: readonly string[]): string | null => {
    const target = readScopeRef(ref, scopes);
    return 'outOfBounds' in target ? null : joinPath(target.scope, target.path);
  };
  visitCondition<readonly string[]>(
    condition,
    (node, scopes) => {
      if (isLogicalNode(node)) return;
      for (const ref of valueRefs(node)) add(parseScopeRef(ref) ? absolute(ref, scopes) : ref);
      const field =
        typeof node.field === 'string' && node.field !== '' ? absolute(node.field, scopes) : null;
      add(field);
      if (!isRelationNode(node)) return;
      // A fieldless array node iterates the scope it sits in.
      const elements = field ?? scopes[scopes.length - 1];
      for (const ref of elementRefs(node)) add(joinPath(elements, ref));
      return [...scopes, elements];
    },
    [''],
  );
  return [...found];
};
