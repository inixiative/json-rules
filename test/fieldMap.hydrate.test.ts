import { describe, expect, test } from 'bun:test';
import type { ProviderResolver } from '../src/fieldMap/hydrate';
import { hydrateFieldMap, hydrateFieldMapSet } from '../src/fieldMap/hydrate';
import type { FieldMap, FieldMapEntry } from '../src/toPrisma/types';

const baseMap: FieldMap = {
  Contact: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
    },
    providers: [{ source: 'contactCustomFields' }],
  },
  Account: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
    },
  },
};

const resolver: ProviderResolver = (source) => {
  if (source === 'contactCustomFields') {
    return {
      industry: { kind: 'enum', type: 'String', options: ['tech', 'finance', 'healthcare'] },
      score: { kind: 'scalar', type: 'Int' },
    };
  }
  return {} as Record<string, FieldMapEntry>;
};

describe('hydrateFieldMap', () => {
  test('injects provider fields into model.fields', async () => {
    const hydrated = await hydrateFieldMap(baseMap, resolver);
    expect(hydrated.Contact.fields.industry).toEqual({
      kind: 'enum',
      type: 'String',
      options: ['tech', 'finance', 'healthcare'],
    });
    expect(hydrated.Contact.fields.score).toEqual({ kind: 'scalar', type: 'Int' });
  });

  test('preserves existing static fields', async () => {
    const hydrated = await hydrateFieldMap(baseMap, resolver);
    expect(hydrated.Contact.fields.id).toEqual({ kind: 'scalar', type: 'String' });
    expect(hydrated.Contact.fields.email).toEqual({ kind: 'scalar', type: 'String' });
  });

  test('models without providers are unchanged', async () => {
    const hydrated = await hydrateFieldMap(baseMap, resolver);
    expect(Object.keys(hydrated.Account.fields)).toEqual(['id']);
  });

  test('does not mutate the original map', async () => {
    await hydrateFieldMap(baseMap, resolver);
    expect(baseMap.Contact.fields.industry).toBeUndefined();
  });

  test('merges multiple providers on the same model', async () => {
    const map: FieldMap = {
      Contact: {
        fields: { id: { kind: 'scalar', type: 'String' } },
        providers: [{ source: 'setA' }, { source: 'setB' }],
      },
    };
    const multi: ProviderResolver = (source) => {
      if (source === 'setA') return { fieldA: { kind: 'scalar', type: 'String' } };
      if (source === 'setB') return { fieldB: { kind: 'scalar', type: 'Boolean' } };
      return {} as Record<string, FieldMapEntry>;
    };
    const hydrated = await hydrateFieldMap(map, multi);
    expect(hydrated.Contact.fields.fieldA).toBeDefined();
    expect(hydrated.Contact.fields.fieldB).toBeDefined();
  });

  test('accepts an async resolver', async () => {
    const asyncResolver: ProviderResolver = async (source) => {
      if (source === 'contactCustomFields') {
        return { asyncField: { kind: 'scalar', type: 'String' } };
      }
      return {} as Record<string, FieldMapEntry>;
    };
    const hydrated = await hydrateFieldMap(baseMap, asyncResolver);
    expect(hydrated.Contact.fields.asyncField).toBeDefined();
  });
});

describe('hydrateFieldMapSet', () => {
  test('hydrates every map in the set', async () => {
    const set = {
      crm: baseMap,
      other: {
        Lead: {
          fields: { id: { kind: 'scalar', type: 'String' } as const },
          providers: [{ source: 'contactCustomFields' }],
        },
      },
    };
    const hydrated = await hydrateFieldMapSet(set, resolver);
    expect(hydrated.crm.Contact.fields.industry).toBeDefined();
    expect(hydrated.other.Lead.fields.industry).toBeDefined();
  });
});
