import { UsageError } from '../errors';
import type { CompileOptions, Condition } from '../types.ts';
import { getLensRoot } from './chain.ts';
import { narrowRule } from './narrowRule.ts';
import { LensRefusal } from './policy.ts';
import { validateRuleInLens } from './validateRuleInLens.ts';

/**
 * A compile under `lens`, or without one: `compile` run on the rule and options with `lens`
 * applied (see below). A compile failure that the bare rule doesn't meet — compiled against the
 * same base lens without the lens's grants — is the lens's: a `LensRefusal`, never a plain Error.
 */
export const compileWithLens = <O extends CompileOptions, R>(
  rule: Condition,
  options: O | undefined,
  rail: 'toSql' | 'toPrisma',
  compile: (condition: Condition, options: O | undefined) => R,
): R => {
  const under = compileUnderLens(rule, options, rail);
  if (under.options === options) return compile(under.condition, under.options);
  try {
    return compile(under.condition, under.options);
  } catch (error) {
    if (error instanceof LensRefusal || error instanceof UsageError) throw error;
    try {
      compile(rule, under.options);
    } catch {
      throw error;
    }
    throw new LensRefusal(
      `${rail}: the lens's grants on this rule have no ${rail} form — ${(error as Error).message}`,
      // The rail the caller picked can't hold them; check() can, and the lens is valid.
      'unsupported_target',
    );
  }
};

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
    throw new UsageError(
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
