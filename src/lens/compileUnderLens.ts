import type { CompileOptions, Condition } from '../types.ts';
import { getLensRoot } from './chain.ts';
import { narrowRule } from './narrowRule.ts';
import { validateRuleInLens } from './validateRuleInLens.ts';

/**
 * A compile's rule and options with `lens` applied: the rule gated by it (`validateRuleInLens` — a rule it
 * refuses throws), narrowed by it (`narrowRule`), and compiled against the base lens's maps, map and
 * model. A lens names its own schema, so passing `map` / `mapName` / `model` with it is a caller
 * bug.
 */
export const compileUnderLens = <O extends CompileOptions>(
  condition: Condition,
  options: O | undefined,
  rail: 'toSql' | 'toPrisma',
): { condition: Condition; options: O | undefined } => {
  if (options?.lens === undefined) return { condition, options };
  const { lens } = options;
  if (options.map !== undefined || options.mapName !== undefined || options.model !== undefined)
    throw new Error(
      `${rail}: pass \`lens\` or \`map\` / \`mapName\` / \`model\`, not both — the lens names its own`,
    );
  const gate = validateRuleInLens(condition, lens);
  if (!gate.ok)
    throw new Error(
      `${rail}: the rule leaves the lens — ${gate.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`,
    );
  const root = getLensRoot(lens);
  return {
    condition: narrowRule(condition, lens),
    options: { ...options, lens: undefined, map: root, mapName: root.mapName, model: root.model },
  };
};
