import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      deletedAt: { kind: 'scalar', type: 'DateTime' },
    },
  },
};

const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' };

const rule: Condition = { field: 'email', operator: Operator.equals, value: 'x' };

const cDeletedNull: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
const cOrgEq: Condition = { field: 'id', operator: Operator.equals, value: 'org-1' };

describe('applyLens', () => {
  test('lens with no narrowing returns rule unchanged', () => {
    expect(applyLens(rule, lens)).toBe(rule);
  });

  test('narrowing without constrains returns rule unchanged', () => {
    const n: LensNarrowing = { parent: lens, maps: {} };
    expect(applyLens(rule, n)).toBe(rule);
  });

  test('single constrains ANDs into rule', () => {
    const n: LensNarrowing = { parent: lens, maps: {}, constrains: cDeletedNull };
    expect(applyLens(rule, n)).toEqual({ all: [cDeletedNull, rule] });
  });

  test('chain composes constrains root → leaf, then rule', () => {
    const a: LensNarrowing = { parent: lens, maps: {}, constrains: cDeletedNull };
    const b: LensNarrowing = { parent: a, maps: {}, constrains: cOrgEq };
    expect(applyLens(rule, b)).toEqual({ all: [cDeletedNull, cOrgEq, rule] });
  });

  test('chain skips narrowings without constrains', () => {
    const a: LensNarrowing = { parent: lens, maps: {}, constrains: cDeletedNull };
    const b: LensNarrowing = { parent: a, maps: {} };
    const c: LensNarrowing = { parent: b, maps: {}, constrains: cOrgEq };
    expect(applyLens(rule, c)).toEqual({ all: [cDeletedNull, cOrgEq, rule] });
  });
});
