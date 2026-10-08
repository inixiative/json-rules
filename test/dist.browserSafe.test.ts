import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type * as JsonRules from '../index';
import type { FieldMap } from '../src/fieldMap/types';
import { getWhere } from './fixtures/helpers';

// Browser bundles (rules-builder, Zealot's storybook) reach the whole package: a top-level
// 'node:module' import breaks them. Prisma's AnyNull is still resolved on the server.

const root = join(import.meta.dir, '..');
// Under the repo so the built files resolve the installed @prisma/client.
const out = join(root, 'node_modules', '.cache', 'json-rules-dist-test');
const requireHere = createRequire(import.meta.url);

const map: FieldMap = {
  models: { Row: { fields: { metadata: { kind: 'scalar', type: 'Json' } } } },
};
const jsonNullCheck = { field: 'metadata', operator: 'isEmpty' } as const;
const prismaAnyNull = (requireHere('@prisma/client/runtime/client') as { AnyNull: unknown })
  .AnyNull;

// Prisma knows AnyNull by identity.
const nullBranch = (where: Record<string, unknown>): unknown =>
  (where.OR as { metadata: { equals: unknown } }[])[0].metadata.equals;

beforeAll(() => {
  rmSync(out, { recursive: true, force: true });
  const build = Bun.spawnSync(['bunx', 'tsup', '--out-dir', out], { cwd: root });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
}, 120_000);

describe('the built dist', () => {
  test('imports no node:module at the top level', () => {
    const esm = readFileSync(join(out, 'index.js'), 'utf8');
    const cjs = readFileSync(join(out, 'index.cjs'), 'utf8');
    // Matched as booleans: a failure would otherwise print the whole bundle.
    expect(/from\s*["'](node:)?module["']/.test(esm)).toBe(false);
    expect(/import\s*\(?\s*["'](node:)?module["']/.test(esm)).toBe(false);
    expect(/require\(\s*["'](node:)?module["']\s*\)/.test(cjs)).toBe(false);
  });

  test("ESM compiles a Json null check with the installed Prisma's AnyNull", async () => {
    const { toPrisma } = (await import(join(out, 'index.js'))) as typeof JsonRules;
    const where = getWhere(toPrisma(jsonNullCheck, { map, model: 'Row' }));
    expect(nullBranch(where)).toBe(prismaAnyNull);
  });

  test("CJS compiles a Json null check with the installed Prisma's AnyNull", () => {
    const { toPrisma } = requireHere(join(out, 'index.cjs')) as typeof JsonRules;
    const where = getWhere(toPrisma(jsonNullCheck, { map, model: 'Row' }));
    expect(nullBranch(where)).toBe(prismaAnyNull);
  });

  test("emits every file package.json's exports name, CJS types included", () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, Record<string, Record<string, string>>>;
    };
    const { import: esm, require: cjs } = pkg.exports['.'];
    expect(cjs.types).toBe('./dist/index.d.cts');
    for (const file of [esm.types, esm.default, cjs.types, cjs.default])
      expect(existsSync(join(out, file.replace('./dist/', '')))).toBe(true);
  });
});
