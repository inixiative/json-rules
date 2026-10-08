import { describe, expect, test } from 'bun:test';
import {
  composeLens,
  type Lens,
  type LensNarrowing,
  projectLens,
  type StoredLens,
  storeLens,
  assertValidNarrowing as validateNarrowingOrThrow,
} from '../index';
import type { FieldMap } from '../src/fieldMap/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        ssn: { kind: 'scalar', type: 'String' },
        orgId: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const base: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };
const org: LensNarrowing = {
  parent: base,
  root: { where: { field: 'orgId', operator: 'equals', value: 'acme' } },
};
const clamp: LensNarrowing = { parent: org, root: { omits: ['ssn'] } };

const byId = (records: StoredLens[]): Record<string, StoredLens> =>
  Object.fromEntries(records.map((record) => [record.id, record]));

describe('a lens has three forms: composed, stored, projected', () => {
  test('stored is one record per layer, each listing every layer it composes with', () => {
    const records = storeLens(clamp, ['user', 'org-acme', 'clamp-7']);
    expect(records.map(({ id, parents }) => ({ id, parents }))).toEqual([
      { id: 'user', parents: [] },
      { id: 'org-acme', parents: ['user'] },
      { id: 'clamp-7', parents: ['user', 'org-acme'] },
    ]);
    expect(records[2]).toEqual({ id: 'clamp-7', parents: ['user', 'org-acme'], root: clamp.root });
  });

  test('composing the stored records gives back the composed lens, through JSON', () => {
    const records = JSON.parse(JSON.stringify(storeLens(clamp, ['user', 'org-acme', 'clamp-7'])));
    const composed = composeLens('clamp-7', byId(records));
    expect(projectLens(composed)).toEqual(projectLens(clamp));
    expect(projectLens(composeLens('org-acme', byId(records)))).toEqual(projectLens(org));
    expect(composeLens('user', byId(records))).toEqual(base);
  });

  test('a missing record, a base out of place, a stale list or a repeated id fails closed', () => {
    const records = byId(storeLens(clamp, ['user', 'org-acme', 'clamp-7']));
    const without = (id: string) =>
      Object.fromEntries(Object.entries(records).filter(([k]) => k !== id));
    expect(() => composeLens('clamp-7', without('org-acme'))).toThrow("no stored lens 'org-acme'");
    const orphan: StoredLens = { id: 'orphan', parents: [], root: { omits: ['ssn'] } };
    expect(() => composeLens('orphan', { orphan })).toThrow('is not a base lens');
    const rebased: StoredLens = { ...records.user, id: 'rebased', parents: ['user'] };
    expect(() => composeLens('rebased', { ...records, rebased })).toThrow('can only head a chain');
    expect(() =>
      composeLens('clamp-7', { ...records, 'org-acme': { ...records['org-acme'], parents: [] } }),
    ).toThrow('composes with []');
    expect(() =>
      composeLens('clamp-7', {
        ...records,
        'clamp-7': { ...records['clamp-7'], parents: ['user', 'user'] },
      }),
    ).toThrow('lists a layer twice');
    expect(() =>
      composeLens('clamp-7', {
        ...records,
        'clamp-7': { ...records['clamp-7'], parents: ['user', 'org-acme', 'user'] },
      }),
    ).toThrow('lists a layer twice');
  });

  test('each layer is validated against the ones above it', () => {
    const records = byId(storeLens(clamp, ['user', 'org-acme', 'clamp-7']));
    const widened: StoredLens = {
      id: 'wide',
      parents: ['user', 'org-acme', 'clamp-7'],
      root: { picks: ['ssn'] },
    };
    expect(() => composeLens('wide', { ...records, wide: widened })).toThrow(/ssn/);
  });

  test('a record id named after an Object.prototype key is not found', () => {
    expect(() => composeLens('toString', {})).toThrow("no stored lens 'toString'");
  });

  test('storeLens needs one id per layer', () => {
    expect(() => storeLens(clamp, ['user', 'clamp-7'])).toThrow('3 layers');
  });
});

describe('a stored layer composes only through its parents', () => {
  test('a record carrying its own parent is refused, so it cannot drop the layers above it', () => {
    const records = byId(storeLens(clamp, ['base', 'org', 'clamp']));
    const forged = { ...records.clamp, parent: base } as unknown as StoredLens;
    expect(() => composeLens('clamp', { ...records, clamp: forged })).toThrow(/carries a parent/);
  });
});

describe('a source label is exempt only for the layer that set the value in force', () => {
  const owner: LensNarrowing = {
    parent: base,
    root: { omits: ['name'], sources: { id: { label: 'name' } } },
  };
  const relabeled: LensNarrowing = { parent: owner, root: { sources: { id: { label: 'orgId' } } } };

  test('a layer restating the label keeps it', () => {
    expect(() =>
      validateNarrowingOrThrow({ parent: owner, root: { sources: { id: { label: 'name' } } } }),
    ).not.toThrow();
  });

  test('a later layer cannot bring back a hidden label a layer between replaced', () => {
    expect(() =>
      validateNarrowingOrThrow({ parent: relabeled, root: { sources: { id: { label: 'name' } } } }),
    ).toThrow(/hidden by another layer/);
  });
});
