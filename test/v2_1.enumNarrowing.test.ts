import { describe, expect, test } from 'bun:test';
import { projectNarrowing } from '../src/lens/project';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

// ModelNarrowing.enumPicks / enumOmits restrict allowed enum values at the
// per-field, per-visit level. Composes with FieldMap.enums (registry),
// FieldMapEntry.values (per-field override), and mapDefaults.enums.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        accessLevel: { kind: 'enum', type: 'AccessLevel' },
      },
    },
    Audit: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        targetRole: { kind: 'enum', type: 'UserRole' }, // same enum as User.role
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
    const n = withParent(lens, {
      root: { enumPicks: { role: ['admin', 'member'] } },
    });
    const out = projectNarrowing(n);
    // The projected field entry carries the resolved allowed values
    expect(out.maps.prisma.models.User.fields.role.values).toEqual(['admin', 'member']);
  });

  test('enumPicks on User.role does NOT affect Audit.targetRole (per-field, not per-type)', () => {
    const n = withParent(lens, {
      root: { enumPicks: { role: ['admin'] } },
      // Audit has no narrowing — should retain registry values
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.models.User.fields.role.values).toEqual(['admin']);
    // Audit.targetRole retains the full UserRole registry
    expect(
      out.maps.prisma.models.Audit.fields.targetRole.values ?? out.maps.prisma.enums?.UserRole,
    ).toContain('owner');
  });

  test('enumOmits drops listed values', () => {
    const n = withParent(lens, {
      root: { enumOmits: { role: ['owner', 'guest'] } },
    });
    const out = projectNarrowing(n);
    expect([...(out.maps.prisma.models.User.fields.role.values ?? [])].sort()).toEqual([
      'admin',
      'member',
    ]);
  });

  test('enumPicks intersects with mapDefaults.enums (both narrow)', () => {
    // mapDefaults.enums.UserRole drops owner globally; enumPicks on User.role keeps [member, owner]
    // Intersection: [member]
    const n = withParent(lens, {
      root: { enumPicks: { role: ['member', 'owner'] } },
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['owner'] } } } },
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.models.User.fields.role.values).toEqual(['member']);
  });

  test('chained enumPicks intersect across narrowing layers', () => {
    const a = withParent(lens, {
      root: { enumPicks: { role: ['admin', 'member', 'owner'] } },
    });
    const b = withParent(a, {
      root: { enumPicks: { role: ['member', 'owner', 'guest'] } },
    });
    const out = projectNarrowing(b);
    // Intersection of [admin,member,owner] and [member,owner,guest] = [member,owner]
    expect([...(out.maps.prisma.models.User.fields.role.values ?? [])].sort()).toEqual([
      'member',
      'owner',
    ]);
  });

  test('all three enum narrowing layers compose at one visit (root + mapDefaults.enums + mapDefaults.models)', () => {
    // Three independent narrowings apply simultaneously at User.role at the root visit:
    //   Registry:                                 UserRole = [admin, member, owner, guest]
    //   mapDefaults.enums.UserRole.omits         drop 'guest'        → [admin, member, owner]
    //   mapDefaults.models.User.enumOmits.role   drop 'owner'        → [admin, member]
    //   root.enumPicks.role                      pick ['admin']      → [admin]
    // Effective allowed values at User.role: ['admin'].
    const n = withParent(lens, {
      root: { enumPicks: { role: ['admin'] } },
      mapDefaults: {
        prisma: {
          enums: { UserRole: { omits: ['guest'] } },
          models: { User: { enumOmits: { role: ['owner'] } } },
        },
      },
    });
    const out = projectNarrowing(n);
    expect(out.maps.prisma.models.User.fields.role.values).toEqual(['admin']);
    // Audit.targetRole only sees the registry-level narrowing (guest dropped),
    // since the User-specific enumOmits and root enumPicks don't apply to Audit.
    // The narrowing for an unvisited model surfaces via the (now-narrowed) registry,
    // not as per-field `values` on the field entry.
    expect(
      [
        ...(out.maps.prisma.models.Audit.fields.targetRole.values ??
          out.maps.prisma.enums?.UserRole ??
          []),
      ].sort(),
    ).toEqual(['admin', 'member', 'owner']);
  });
});
