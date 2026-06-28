import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens, createLens } from '../index';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        metadata: { kind: 'scalar', type: 'Json' },
      },
    },
  },
};

const lens = createLens({ maps: { app: map }, mapName: 'app', model: 'User' });

describe('checkRuleAgainstLens — Json sub-paths', () => {
  test('a dotted sub-path into a visible Json column resolves (no violation)', () => {
    const res = checkRuleAgainstLens(
      { all: [{ field: 'metadata.theme', operator: 'equals', value: 'dark' }] },
      lens,
    );
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  test('a deeper sub-path also resolves', () => {
    const res = checkRuleAgainstLens(
      { all: [{ field: 'metadata.display.mode', operator: 'equals', value: 'dark' }] },
      lens,
    );
    expect(res.ok).toBe(true);
  });

  test('the bare Json column resolves', () => {
    const res = checkRuleAgainstLens({ all: [{ field: 'metadata', operator: 'exists' }] }, lens);
    expect(res.ok).toBe(true);
  });

  test('a sub-path under a non-existent column still fails', () => {
    const res = checkRuleAgainstLens(
      { all: [{ field: 'nope.theme', operator: 'equals', value: 'x' }] },
      lens,
    );
    expect(res.ok).toBe(false);
  });
});
