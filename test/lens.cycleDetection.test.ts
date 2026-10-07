import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '../src/fieldMap/types';
import { assertValidNarrowing } from '../src/lens/narrowing';
import { narrowRule } from '../src/lens/narrowRule';
import { projectPaths } from '../src/lens/projectPaths';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { getRoot } from '../src/lens/walk';
import { Operator } from '../src/operator';

const map: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' };

describe('narrowing parent-chain cycle detection', () => {
  test('getRoot throws on cyclic chain', () => {
    const a = { parent: lens } as LensNarrowing;
    const b = { parent: a } as LensNarrowing;
    a.parent = b;
    expect(() => getRoot(b)).toThrow(/cycle detected/);
  });

  test('projectPaths throws on cyclic chain', () => {
    const a = { parent: lens } as LensNarrowing;
    const b = { parent: a } as LensNarrowing;
    a.parent = b;
    expect(() => projectPaths(b)).toThrow(/cycle detected/);
  });

  test('narrowRule throws on cyclic chain', () => {
    const a = { parent: lens } as LensNarrowing;
    const b = { parent: a } as LensNarrowing;
    a.parent = b;
    const rule = { field: 'email', operator: Operator.equals, value: 'x' };
    expect(() => narrowRule(rule, b)).toThrow(/cycle detected/);
  });

  test('validateNarrowing throws on cyclic chain', () => {
    const a = { parent: lens } as LensNarrowing;
    const b = { parent: a } as LensNarrowing;
    a.parent = b;
    expect(() => assertValidNarrowing(b)).toThrow(/cycle detected/);
  });
});
