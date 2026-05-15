import { describe, expect, test } from 'bun:test';
import { hydrateFieldMap } from '../src/fieldMap/hydrate';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import { lensFromSnapshot, snapshotLens } from '../src/lens/snapshot';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap, FieldMapEntry } from '../src/toPrisma/types';

const staticMap: FieldMap = {
  Contact: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
    },
    providers: [{ source: 'customFields' }],
  },
};

const resolver = (source: string): Record<string, FieldMapEntry> => {
  if (source === 'customFields') {
    return {
      industry: { kind: 'enum', type: 'String', options: ['tech', 'finance'] },
      score: { kind: 'scalar', type: 'Int' },
    };
  }
  return {};
};

describe('snapshotLens', () => {
  test('captures full unnarrowed lens surface', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const snapshot = snapshotLens(lens);

    expect(snapshot.model).toBe('Contact');
    expect(snapshot.mapName).toBe('default');
    expect(snapshot.fieldMapSet.default.Contact.fields.industry).toBeDefined();
    expect(snapshot.fieldMapSet.default.Contact.fields.score).toBeDefined();
    expect(snapshot.fieldMapSet.default.Contact.fields.email).toBeDefined();
  });

  test('captures only narrowed fields when picks applied', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: { default: { models: { Contact: { picks: ['email', 'industry'] } } } },
    };
    const snapshot = snapshotLens(narrowing);

    const fields = snapshot.fieldMapSet.default.Contact.fields;
    expect(Object.keys(fields).sort()).toEqual(['email', 'industry']);
    expect(fields.score).toBeUndefined();
    expect(fields.id).toBeUndefined();
  });

  test('preserves enum options in snapshot', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: { default: { models: { Contact: { picks: ['industry'] } } } },
    };
    const snapshot = snapshotLens(narrowing);
    expect(snapshot.fieldMapSet.default.Contact.fields.industry?.options).toEqual([
      'tech',
      'finance',
    ]);
  });

  test('snapshot is JSON round-trippable', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const snapshot = snapshotLens(lens);
    const restored = JSON.parse(JSON.stringify(snapshot));
    expect(restored.fieldMapSet.default.Contact.fields.industry).toBeDefined();
  });
});

describe('lensFromSnapshot', () => {
  test('reconstructed lens passes checkRuleAgainstLens for visible fields', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: { default: { models: { Contact: { picks: ['email', 'industry'] } } } },
    };

    const snapshot = snapshotLens(narrowing);
    const reconstructed = lensFromSnapshot(snapshot);

    const rule = { field: 'industry', operator: Operator.equals, value: 'tech' };
    const { ok } = checkRuleAgainstLens(rule, reconstructed);
    expect(ok).toBe(true);
  });

  test('reconstructed lens rejects fields outside the snapshot', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const narrowing: LensNarrowing = {
      parent: lens,
      maps: { default: { models: { Contact: { picks: ['email'] } } } },
    };

    const snapshot = snapshotLens(narrowing);
    const reconstructed = lensFromSnapshot(snapshot);

    const rule = { field: 'score', operator: Operator.greaterThan, value: 50 };
    const { ok, violations } = checkRuleAgainstLens(rule, reconstructed);
    expect(ok).toBe(false);
    expect(violations[0].path).toBe('score');
  });

  test('snapshot survives JSON round-trip and still evaluates correctly', async () => {
    const map = await hydrateFieldMap(staticMap, resolver);
    const lens: Lens = { map, model: 'Contact' };
    const snapshot = snapshotLens(lens);

    const restoredSnapshot = JSON.parse(JSON.stringify(snapshot));
    const reconstructed = lensFromSnapshot(restoredSnapshot);

    const rule = { field: 'industry', operator: Operator.equals, value: 'tech' };
    const { ok } = checkRuleAgainstLens(rule, reconstructed);
    expect(ok).toBe(true);
  });
});
