import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as api from '../index';

// One implementation per verb (docs/VERBS.md). Each rule names a pattern that is a verb's
// implementation and the only modules allowed to contain it; a copy anywhere else fails here.

const ROOT = join(import.meta.dir, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [relative(ROOT, path)] : [];
  });

// Comments are prose, not implementations.
const code = (file: string): string =>
  readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SOURCES = walk(join(ROOT, 'src')).map((file) => ({ file, code: code(file) }));

// The evaluators and compilers keep their own descent — it is their semantics (CLAUDE.md).
const OWN_DESCENT = [
  'src/check.ts',
  'src/negate.ts',
  'src/validate.ts',
  'src/toSql/condition.ts',
  'src/toSql/logical.ts',
  'src/toPrisma/condition.ts',
  'src/toPrisma/logical.ts',
];

const RULES: { verb: string; pattern: RegExp; owners: string[] }[] = [
  {
    verb: 'traverse a condition tree',
    pattern: /'(all|any|if)' in |\.(all|any)\.(map|some|every|forEach)\(/,
    owners: ['src/traverse.ts', ...OWN_DESCENT],
  },
  {
    verb: 'read a field-map record (own-property)',
    pattern: /\.(models|fields|maps)\[[^\]]+\](?!\s*=[^=])/,
    owners: ['src/own.ts'],
  },
  {
    verb: 'read a path (own-property)',
    pattern: /import\s*\{[^}]*\bget\b[^}]*\}\s*from\s*'lodash-es'/,
    owners: ['src/engineGlobals.ts'],
  },
  {
    verb: 'define an operator set',
    pattern:
      /\[\s*(?:(?:Array|Date)?Operator\.\w+\s*,\s*){1,}|=== (?:Array|Date)?Operator\.\w+ \|\|[^|]*=== (?:Array|Date)?Operator\./,
    owners: ['src/operatorCatalog.ts'],
  },
  {
    verb: 'name a bridge endpoint (map:Model)',
    pattern: /\$\{[\w.]*fieldMap\}:\$\{|split\(':'\)/,
    owners: ['src/fieldMap/endpointKey.ts'],
  },
  {
    verb: 'recurse into a child condition (one forward declaration per rail)',
    pattern: /type BuildConditionFn|let (?:dispatch|buildCondition)\b/,
    owners: ['src/toPrisma/recurse.ts', 'src/toSql/recurse.ts'],
  },
  {
    verb: 'build a Prisma logical constant',
    pattern: /\{ OR: \[\] \}|\{ AND: \[|\{ NOT: |return \{\};/,
    owners: ['src/toPrisma/logical.ts'],
  },
  {
    verb: 'default the time zone',
    pattern: /'UTC'/,
    owners: ['src/dateExpr.ts'],
  },
  {
    verb: 'parse a date',
    pattern: /Date\.parse\(|dayjs\.tz\(/,
    owners: ['src/date.ts', 'src/dateExpr.ts'],
  },
  {
    verb: 'shape a rolling expression',
    pattern: /'(ago|ahead)' in |\{ (ago|ahead): /,
    owners: ['src/dateExpr.ts', 'src/types.ts'],
  },
  {
    verb: 'read a binding',
    pattern: /Object\.hasOwn\(bindings/,
    owners: ['src/valueSource.ts', 'src/bindings.ts'],
  },
  {
    verb: 'walk a field path through a FieldMap',
    pattern: /\.split\('\.'\)[\s\S]{0,400}\b(modelOf|fieldOf)\(/,
    owners: ['src/toPrisma/mapWalk.ts', 'src/lens/policy.ts'],
  },
];

describe('one implementation per verb', () => {
  for (const { verb, pattern, owners } of RULES)
    test(verb, () => {
      const outside = SOURCES.filter((s) => !owners.includes(s.file) && pattern.test(s.code));
      expect(outside.map((s) => s.file)).toEqual([]);
    });
});

describe('the public API', () => {
  const doc = readFileSync(join(ROOT, 'docs/VERBS.md'), 'utf8');
  const exported = Object.keys(api).filter((name) => typeof (api as never)[name] === 'function');

  test('every exported function is in the verb catalog', () => {
    expect(exported.filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
  });

  test('no public name says resolve — it named five different verbs', () => {
    expect(Object.keys(api).filter((name) => /^resolve[A-Z]/.test(name))).toEqual([]);
  });
});
