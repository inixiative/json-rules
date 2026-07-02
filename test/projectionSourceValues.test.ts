import { describe, expect, test } from 'bun:test';
import { exposedSurface } from '../src/lens/exposedSurface';
import { projectByPath, type SourceValues } from '../src/lens/projectByPath';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';
import { enumOptions } from './fixtures/helpers';

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

describe('exposedSurface — fetched sourceValues fold onto field.options (per model)', () => {
  test('a sourced scalar gains the fetched options (value/label pairs)', () => {
    const sourceValues: SourceValues[] = [
      {
        path: 'User',
        mapName: 'app',
        model: 'User',
        field: 'tier',
        options: [{ value: 'gold' }, { value: 'silver' }],
      },
    ];
    const surface = exposedSurface(lens, { sourceValues });
    expect(surface.maps.app.models.User.fields.tier.options).toEqual([
      { value: 'gold' },
      { value: 'silver' },
    ]);
  });

  test('labeled options carry their label', () => {
    const surface = exposedSurface(lens, {
      sourceValues: [
        {
          path: 'User',
          mapName: 'app',
          model: 'User',
          field: 'tier',
          options: [
            { value: 'gold', label: 'Gold' },
            { value: 'silver', label: 'Silver' },
          ],
        },
      ],
    });
    expect(surface.maps.app.models.User.fields.tier.options).toEqual([
      { value: 'gold', label: 'Gold' },
      { value: 'silver', label: 'Silver' },
    ]);
  });

  test('fetched options land on an enum field (enum registry stays on values)', () => {
    const surface = exposedSurface(lens, {
      sourceValues: [
        {
          path: 'User',
          mapName: 'app',
          model: 'User',
          field: 'role',
          options: [{ value: 'admin', label: 'Admin' }],
        },
      ],
    });
    const role = surface.maps.app.models.User.fields.role;
    expect(role.options).toEqual([{ value: 'admin', label: 'Admin' }]);
    expect(role.values).toEqual(['admin', 'member', 'guest']);
  });

  test('options for the same model+field across paths union (dedup by value, label kept)', () => {
    const surface = exposedSurface(lens, {
      sourceValues: [
        {
          path: 'User.region',
          mapName: 'app',
          model: 'Region',
          field: 'code',
          options: [{ value: 'X', label: 'Ex' }],
        },
        {
          path: 'A.b.region',
          mapName: 'app',
          model: 'Region',
          field: 'code',
          options: [{ value: 'Y', label: 'Why' }],
        },
      ],
    });
    const code = surface.maps.app.models.Region.fields.code;
    expect([...(code.options ?? [])].sort((a, b) => a.value.localeCompare(b.value))).toEqual([
      { value: 'X', label: 'Ex' },
      { value: 'Y', label: 'Why' },
    ]);
  });

  test('without sourceValues, a plain scalar has no options but an enum still exposes its set', () => {
    const surface = exposedSurface(lens);
    // tier is a plain scalar with no allowed-set → no options, no values.
    expect(surface.maps.app.models.User.fields.tier.options).toBeUndefined();
    expect(surface.maps.app.models.User.fields.tier.values).toBeUndefined();
    // role is value-gated (enum) → its selectable set surfaces as options uniformly.
    expect(surface.maps.app.models.User.fields.role.options).toEqual(
      enumOptions('admin', 'member', 'guest'),
    );
  });
});

describe('projectByPath — fetched sourceValues fold per path (exact)', () => {
  const narrowed: LensNarrowing = { parent: lens, root: { relations: { region: {} } } };

  test('each path gets its own fetched options', () => {
    const proj = projectByPath(narrowed, {
      sourceValues: [
        {
          path: 'User',
          mapName: 'app',
          model: 'User',
          field: 'tier',
          options: [{ value: 'a' }],
        },
        {
          path: 'User.region',
          mapName: 'app',
          model: 'Region',
          field: 'code',
          options: [{ value: 'b', label: 'Bee' }],
        },
      ],
    });
    expect(proj.get('User')?.fields.tier.options).toEqual([{ value: 'a' }]);
    expect(proj.get('User.region')?.fields.code.options).toEqual([{ value: 'b', label: 'Bee' }]);
  });

  test('an option at one path does not leak to another', () => {
    const proj = projectByPath(narrowed, {
      sourceValues: [
        {
          path: 'User.region',
          mapName: 'app',
          model: 'Region',
          field: 'code',
          options: [{ value: 'b' }],
        },
      ],
    });
    expect(proj.get('User')?.fields.tier.options).toBeUndefined();
  });

  test('a bare (label-less) source folds pairs without labels', () => {
    const proj = projectByPath(lens, {
      sourceValues: [
        {
          path: 'User',
          mapName: 'app',
          model: 'User',
          field: 'tier',
          options: [{ value: 'gold' }],
        },
      ],
    });
    expect(proj.get('User')?.fields.tier.options).toEqual([{ value: 'gold' }]);
  });
});
