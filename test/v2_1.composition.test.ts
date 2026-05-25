import { describe, expect, test } from 'bun:test';
import { projectNarrowing } from '../src/lens/project';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

// The pre-2.1 bug: projectNarrowing mutates a shared cloned FieldMap. When two
// narrowings apply picks to the same model in sequence, the LATER picks computes
// `keep = new Set(picks)` against the ALREADY-narrowed model, so prior picks vanish.
// Correct behavior: each narrowing intersects with what survived previous narrowings.
// Composition must be intersection, never last-write.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

describe('projectNarrowing composition is intersection (not last-write)', () => {
  test('chained picks: A=[email,name,id], B=[name,id,role] → projected={name,id}', () => {
    // Intersection of the two pick sets, not just B's
    const a = withParent(lens, {
      prisma: { models: { User: { picks: ['email', 'name', 'id'] } } },
    });
    const b = withParent(a, {
      prisma: { models: { User: { picks: ['name', 'id', 'role'] } } },
    });
    const out = projectNarrowing(b);
    const fields = Object.keys(out.maps.prisma.models.User.fields).sort();
    expect(fields).toEqual(['id', 'name']);
  });

  // NOTE: chained narrowing where B picks fields A excluded is now a STRICT
  // validation error — see v2_1.validateNarrowing.test.ts. projectNarrowing
  // composition is still intersection-only, but inputs must pass validation first.

  test('pick then omit: pick keeps {email,name}, omit drops name → {email}', () => {
    const a = withParent(lens, {
      prisma: { models: { User: { picks: ['email', 'name'] } } },
    });
    const b = withParent(a, {
      prisma: { models: { User: { omits: ['name'] } } },
    });
    const out = projectNarrowing(b);
    expect(Object.keys(out.maps.prisma.models.User.fields).sort()).toEqual(['email']);
  });

  test('omit accumulates: A omits=[name], B omits=[email] → both gone', () => {
    const a = withParent(lens, {
      prisma: { models: { User: { omits: ['name'] } } },
    });
    const b = withParent(a, {
      prisma: { models: { User: { omits: ['email'] } } },
    });
    const out = projectNarrowing(b);
    const fields = Object.keys(out.maps.prisma.models.User.fields).sort();
    expect(fields).not.toContain('name');
    expect(fields).not.toContain('email');
  });
});
