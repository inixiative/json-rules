import { describe, expect, test } from 'bun:test';
import { projectByPath } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

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

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('projectByPath composition is intersection (not last-write)', () => {
  test('chained picks: A=[email,name,id], B=[name,id,role] → projected={name,id}', () => {
    const a = withParent(lens, { root: { picks: ['email', 'name', 'id'] } });
    const b = withParent(a, { root: { picks: ['name', 'id', 'role'] } });
    const fields = Object.keys(projectByPath(b).get('User')!.fields).sort();
    expect(fields).toEqual(['id', 'name']);
  });

  test('pick then omit: pick keeps {email,name}, omit drops name → {email}', () => {
    const a = withParent(lens, { root: { picks: ['email', 'name'] } });
    const b = withParent(a, { root: { omits: ['name'] } });
    expect(Object.keys(projectByPath(b).get('User')!.fields).sort()).toEqual(['email']);
  });

  test('omit accumulates: A omits=[name], B omits=[email] → both gone', () => {
    const a = withParent(lens, { root: { omits: ['name'] } });
    const b = withParent(a, { root: { omits: ['email'] } });
    const fields = Object.keys(projectByPath(b).get('User')!.fields).sort();
    expect(fields).not.toContain('name');
    expect(fields).not.toContain('email');
  });
});
