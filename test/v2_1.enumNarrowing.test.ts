import { describe, expect, test } from 'bun:test';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';
import { at } from './fixtures/helpers';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        accessLevel: { kind: 'enum', type: 'AccessLevel' },
      },
    },
  },
  enums: {
    UserRole: ['admin', 'member', 'owner', 'guest'],
    AccessLevel: ['read', 'write', 'admin'],
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('ModelNarrowing.enumPicks per-field enum narrowing', () => {
  test('enumPicks restricts a single field to specified values', () => {
    const n = withParent(lens, { root: { enumPicks: { role: ['admin', 'member'] } } });
    const role = at(projectByPath(n), 'User').fields.role;
    expect(role.values).toEqual(['admin', 'member']);
  });

  test('enumPicks on role does NOT affect accessLevel (per-field, not per-type)', () => {
    const n = withParent(lens, { root: { enumPicks: { role: ['admin'] } } });
    const fields = at(projectByPath(n), 'User').fields;
    expect(fields.role.values).toEqual(['admin']);
    expect(fields.accessLevel.values).toEqual(['read', 'write', 'admin']);
  });

  test('enumOmits drops listed values', () => {
    const n = withParent(lens, { root: { enumOmits: { role: ['owner', 'guest'] } } });
    const role = at(projectByPath(n), 'User').fields.role;
    expect([...(role.values ?? [])].sort()).toEqual(['admin', 'member']);
  });

  test('enumPicks intersects with mapDefaults.enums (both narrow)', () => {
    const n = withParent(lens, {
      root: { enumPicks: { role: ['member', 'owner'] } },
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const role = at(projectByPath(n), 'User').fields.role;
    expect(role.values).toEqual(['member']);
  });

  test('chained enumPicks intersect across narrowing layers', () => {
    const a = withParent(lens, { root: { enumPicks: { role: ['admin', 'member', 'owner'] } } });
    const b = withParent(a, { root: { enumPicks: { role: ['member', 'owner', 'guest'] } } });
    const role = at(projectByPath(b), 'User').fields.role;
    expect([...(role.values ?? [])].sort()).toEqual(['member', 'owner']);
  });

  test('all three enum narrowing layers compose at one visit', () => {
    // Registry:                                 UserRole = [admin, member, owner, guest]
    // mapDefaults.enums.UserRole.omits         drop 'guest'        → [admin, member, owner]
    // mapDefaults.models.User.enumOmits.role   drop 'owner'        → [admin, member]
    // root.enumPicks.role                      pick ['admin']      → [admin]
    const n = withParent(lens, {
      root: { enumPicks: { role: ['admin'] } },
      mapDefaults: {
        prisma: {
          enums: { UserRole: { omits: ['guest'] } },
          models: { User: { enumOmits: { role: ['owner'] } } },
        },
      },
    });
    const role = at(projectByPath(n), 'User').fields.role;
    expect(role.values).toEqual(['admin']);
  });
});
