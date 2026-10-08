import { ARRAY_COUNT_OPERATORS } from '../operatorCatalog';
import { visitCondition } from '../traverse';
import type { Condition } from '../types';
import { validateRule } from '../validate';
import { LensRefusal, type Policy } from './policy.ts';

/** What a Prisma compile of a lens's own conditions, AND-ed at a visit, can't hold, as the rule
 *  validator reads it off their shape — no value read (`on` names them) — and, where no step can
 *  run, as in a relation's where in a select (`counting: false`), a count or an aggregate. Each
 *  condition is read once per call and model. */
export const prismaRefusal = (
  policy: Policy,
  conditions: readonly Condition[],
  at: { mapName: string; modelName: string },
  on: string,
  counting: boolean,
): LensRefusal | null => {
  const key = `${at.mapName}\u0000${at.modelName}`;
  for (const condition of conditions) {
    if (typeof condition === 'boolean') continue;
    const read = policy.memo?.compiles.get(condition) ?? new Map<string, string | null>();
    policy.memo?.compiles.set(condition, read);
    let problem = read.get(key);
    if (problem === undefined) {
      const [issue] = validateRule(condition, {
        target: 'toPrisma',
        map: policy.lens,
        mapName: at.mapName,
        model: at.modelName,
      }).errors;
      problem = issue ? issue.message : null;
      read.set(key, problem);
    }
    if (problem !== null) return new LensRefusal(`${on}: ${problem}`, 'unsupported_grant');
  }
  if (counting) return null;
  let counted = false;
  for (const condition of conditions)
    visitCondition(condition, (node) => {
      if ('aggregate' in node || ARRAY_COUNT_OPERATORS.includes(node.arrayOperator as never))
        counted = true;
    });
  return counted
    ? new LensRefusal(
        `${on} needs a counting step (executePrismaPlan), which a relation's where in a select can't run`,
        'unsupported_grant',
      )
    : null;
};
