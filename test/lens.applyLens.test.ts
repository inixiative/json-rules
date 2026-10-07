import { describe, expect, test } from 'bun:test';
import { narrowRule } from '../src/lens/narrowRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};

const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' };

const rule: Condition = { field: 'email', operator: Operator.equals, value: 'x' };

const cDeletedNull: Condition = { field: 'deletedAt', operator: Operator.isEmpty };
const cOrgEq: Condition = { field: 'id', operator: Operator.equals, value: 'org-1' };

describe('narrowRule', () => {
  test('lens with no narrowing returns rule unchanged', () => {
    expect(narrowRule(rule, lens)).toBe(rule);
  });

  test('narrowing without where returns rule unchanged', () => {
    const n: LensNarrowing = { parent: lens };
    expect(narrowRule(rule, n)).toBe(rule);
  });

  test('single root.where ANDs into rule', () => {
    const n: LensNarrowing = { parent: lens, root: { where: cDeletedNull } };
    expect(narrowRule(rule, n)).toEqual({ all: [cDeletedNull, rule] });
  });

  test('chain composes where root → leaf, then rule', () => {
    const a: LensNarrowing = { parent: lens, root: { where: cDeletedNull } };
    const b: LensNarrowing = { parent: a, root: { where: cOrgEq } };
    expect(narrowRule(rule, b)).toEqual({ all: [cDeletedNull, cOrgEq, rule] });
  });

  test('chain skips narrowings without where', () => {
    const a: LensNarrowing = { parent: lens, root: { where: cDeletedNull } };
    const b: LensNarrowing = { parent: a };
    const c: LensNarrowing = { parent: b, root: { where: cOrgEq } };
    expect(narrowRule(rule, c)).toEqual({ all: [cDeletedNull, cOrgEq, rule] });
  });
});
