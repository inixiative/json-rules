import { describe, expect, test } from 'bun:test';
import { exposedSurface } from '../src/lens/exposedSurface';
import { projectByPath, type SourceValues } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        tier: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        region: { kind: 'object', type: 'Region' },
      },
    },
    Region: {
      fields: { code: { kind: 'scalar', type: 'String' } },
    },
  },
  enums: { UserRole: ['admin', 'member', 'guest'] },
};

const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };

describe('exposedSurface — fetched sourceValues fold onto field.values (per model)', () => {
  test('a sourced scalar gains the fetched values', () => {
    const sourceValues: SourceValues[] = [
      { path: 'User', mapName: 'app', model: 'User', field: 'tier', values: ['gold', 'silver'] },
    ];
    const surface = exposedSurface(lens, { sourceValues });
    expect(surface.maps.app.models.User.fields.tier.values).toEqual(['gold', 'silver']);
  });

  test('fetched values OVERRIDE narrowed enum values', () => {
    const surface = exposedSurface(lens, {
      sourceValues: [
        { path: 'User', mapName: 'app', model: 'User', field: 'role', values: ['admin'] },
      ],
    });
    expect(surface.maps.app.models.User.fields.role.values).toEqual(['admin']);
  });

  test('values for the same model+field across paths union', () => {
    const surface = exposedSurface(lens, {
      sourceValues: [
        { path: 'User.region', mapName: 'app', model: 'Region', field: 'code', values: ['X'] },
        { path: 'A.b.region', mapName: 'app', model: 'Region', field: 'code', values: ['Y'] },
      ],
    });
    expect([...(surface.maps.app.models.Region.fields.code.values ?? [])].sort()).toEqual([
      'X',
      'Y',
    ]);
  });

  test('no sourceValues leaves the surface unchanged', () => {
    const surface = exposedSurface(lens);
    expect(surface.maps.app.models.User.fields.tier.values).toBeUndefined();
  });
});

describe('projectByPath — fetched sourceValues fold per path (exact)', () => {
  const narrowed: LensNarrowing = { parent: lens, root: { relations: { region: {} } } };

  test('each path gets its own fetched values', () => {
    const proj = projectByPath(narrowed, {
      sourceValues: [
        { path: 'User', mapName: 'app', model: 'User', field: 'tier', values: ['a'] },
        { path: 'User.region', mapName: 'app', model: 'Region', field: 'code', values: ['b'] },
      ],
    });
    expect(proj.get('User')?.fields.tier.values).toEqual(['a']);
    expect(proj.get('User.region')?.fields.code.values).toEqual(['b']);
  });

  test('a value at one path does not leak to another', () => {
    const proj = projectByPath(narrowed, {
      sourceValues: [
        { path: 'User.region', mapName: 'app', model: 'Region', field: 'code', values: ['b'] },
      ],
    });
    expect(proj.get('User')?.fields.tier.values).toBeUndefined();
  });
});
