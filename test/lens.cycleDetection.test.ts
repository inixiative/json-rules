import { describe, expect, test } from 'bun:test';
import { applyLens } from '../src/lens/applyLens';
import { validateNarrowing } from '../src/lens/narrowing';
import { projectNarrowing } from '../src/lens/project';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { getRoot } from '../src/lens/walk';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  FanUser: {
    fields: { id: { kind: 'scalar', type: 'String' }, email: { kind: 'scalar', type: 'String' } },
  },
};

const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' };

describe('narrowing parent-chain cycle detection', () => {
  test('getRoot throws on cyclic chain', () => {
    const a = { parent: lens, maps: {} } as LensNarrowing;
    const b = { parent: a, maps: {} } as LensNarrowing;
    a.parent = b;
    expect(() => getRoot(b)).toThrow(/cycle detected/);
  });

  test('projectNarrowing throws on cyclic chain', () => {
    const a = { parent: lens, maps: {} } as LensNarrowing;
    const b = { parent: a, maps: {} } as LensNarrowing;
    a.parent = b;
    expect(() => projectNarrowing(b)).toThrow(/cycle detected/);
  });

  test('applyLens throws on cyclic chain', () => {
    const a = { parent: lens, maps: {} } as LensNarrowing;
    const b = { parent: a, maps: {} } as LensNarrowing;
    a.parent = b;
    const rule = { field: 'email', operator: Operator.equals, value: 'x' };
    expect(() => applyLens(rule, b)).toThrow(/cycle detected/);
  });

  test('validateNarrowing throws on cyclic chain', () => {
    const a = { parent: lens, maps: {} } as LensNarrowing;
    const b = { parent: a, maps: {} } as LensNarrowing;
    a.parent = b;
    expect(() => validateNarrowing(b)).toThrow(/cycle detected/);
  });
});
