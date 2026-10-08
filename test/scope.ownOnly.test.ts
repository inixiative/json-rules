import { describe, expect, test } from 'bun:test';
import { check, createLens, readLensValue } from '../index';
import { map } from './rails/harness';

// A path read takes own properties only, inside Json too: an inherited value (a class
// getter) never resolves, and check() and readLensValue read the same thing.

class Profile {
  readonly tier = 'own';
  get plan() {
    return 'inherited';
  }
}

const lens = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const row = { id: 1, name: 'Ann', meta: { profile: new Profile(), tags: ['a', 'b'] } };

describe('own-property path reads', () => {
  test('a class-instance getter reads undefined', () => {
    expect(readLensValue(lens, row, 'meta.profile.plan')).toEqual({ ok: true, value: undefined });
    expect(
      check({ field: 'meta.profile.plan', operator: 'equals', value: 'inherited' }, row),
    ).not.toBe(true);
    expect(check({ field: 'meta.profile.plan', operator: 'isEmpty' }, row)).toBe(true);
  });

  test('check() and readLensValue agree on own and inherited values', () => {
    for (const [path, expected] of [
      ['meta.profile.tier', 'own'],
      ['meta.profile.plan', undefined],
      ['meta.tags[1]', 'b'],
      ['meta.tags.length', 2],
    ] as const) {
      expect(readLensValue(lens, row, path)).toEqual({ ok: true, value: expected });
      expect(check({ field: path, operator: 'equals', value: expected ?? null }, row)).toBe(true);
    }
  });
});
