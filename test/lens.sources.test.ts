import { describe, expect, test } from 'bun:test';
import { getSources } from '../src/lens/applyLens';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

const map: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
    },
  },
};

const lensWithSources: Lens = {
  map,
  mapName: 'prisma',
  model: 'FanUser',
  sources: {
    'prisma:FanUser.customFieldDefinitions': [
      { uuid: 'cfd-1', fieldKey: 'industry', label: 'Industry' },
      { uuid: 'cfd-2', fieldKey: 'region', label: 'Region' },
    ],
    'prisma:Brand': { customConfig: { theme: 'dark' } },
  },
};

const lensNoSources: Lens = { map, mapName: 'prisma', model: 'FanUser' };

describe('getSources', () => {
  test('returns empty object when lens has no sources', () => {
    expect(getSources(lensNoSources)).toEqual({});
  });

  test('returns lens sources for direct lens', () => {
    expect(getSources(lensWithSources)).toEqual(lensWithSources.sources!);
  });

  test('returns root lens sources when called with a narrowing', () => {
    const narrowing: LensNarrowing = { parent: lensWithSources, maps: {} };
    expect(getSources(narrowing)).toEqual(lensWithSources.sources!);
  });

  test('returns root lens sources even through multi-level chain', () => {
    const n1: LensNarrowing = { parent: lensWithSources, maps: {} };
    const n2: LensNarrowing = { parent: n1, maps: {} };
    expect(getSources(n2)).toEqual(lensWithSources.sources!);
  });
});
