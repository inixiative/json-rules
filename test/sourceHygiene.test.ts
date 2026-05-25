import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Catches source-file hygiene issues that bypass typecheck/lint:
// - NUL bytes (\x00) — makes git treat the file as binary, hides diffs
// - Non-printable control characters (except common whitespace: tab/lf/cr)
// These would otherwise only get noticed in a code review by accident.

const SRC_ROOT = join(import.meta.dir, '..', 'src');

const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (stat.isFile() && path.endsWith('.ts')) out.push(path);
  }
  return out;
};

const allSrcFiles = walk(SRC_ROOT);

// Allowed whitespace control chars: tab (9), LF (10), CR (13).
// Reject everything else in the C0 control range [0..31] and DEL (127).
const ALLOWED_CTRL = new Set([9, 10, 13]);

const findBadCtrl = (content: string): { codepoint: number; offset: number } | null => {
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === 127 || (c < 32 && !ALLOWED_CTRL.has(c))) {
      return { codepoint: c, offset: i };
    }
  }
  return null;
};

describe('source hygiene', () => {
  test.each(
    allSrcFiles.map((f) => [f.replace(`${SRC_ROOT}/`, '')]),
  )('no invisible control chars in src/%s', (relativePath: string) => {
    const fullPath = join(SRC_ROOT, relativePath);
    const content = readFileSync(fullPath, 'utf8');
    const bad = findBadCtrl(content);
    if (bad) {
      const line = content.slice(0, bad.offset).split('\n').length;
      const hex = bad.codepoint.toString(16).padStart(2, '0');
      throw new Error(
        `Invisible control character 0x${hex} at line ${line} of src/${relativePath}. ` +
          `These bypass typecheck/lint but break git diff and confuse readers. ` +
          `Replace with a visible delimiter.`,
      );
    }
    expect(bad).toBeNull();
  });
});
