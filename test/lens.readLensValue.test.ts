import { describe, expect, test } from 'bun:test';
import { createLens, type LensNarrowing, readLensValue } from '../index';
import { map } from './rails/harness';

const base = createLens({ maps: { prisma: map }, mapName: 'prisma', model: 'User' });
const lens: LensNarrowing = {
  parent: base,
  root: {
    omits: ['score'],
    relations: {
      org: {
        omits: ['seats'],
        where: { field: 'plan', operator: 'equals', value: 'pro' },
        relations: { parent: {} },
      },
      posts: {},
    },
  },
};

const ann = {
  id: 1,
  name: 'Ann',
  score: 1.5,
  meta: { a: { b: 'x' }, constructor: 'own' },
  org: { id: 10, name: 'Acme', plan: 'pro', seats: 5, parent: { id: 9, name: 'Root' } },
  posts: [{ id: 100, title: 'hello' }],
};
const bob = { ...ann, id: 2, org: { ...ann.org, plan: 'free' } };

describe('readLensValue reads a value as the lens shows it', () => {
  test('a column, a related column, and one two hops down', () => {
    expect(readLensValue(lens, ann, 'name')).toEqual({ ok: true, value: 'Ann' });
    expect(readLensValue(lens, ann, 'org.name')).toEqual({ ok: true, value: 'Acme' });
    expect(readLensValue(lens, ann, 'org.parent.name')).toEqual({ ok: true, value: 'Root' });
  });

  test('inside a Json column, own properties only', () => {
    expect(readLensValue(lens, ann, 'meta.a.b')).toEqual({ ok: true, value: 'x' });
    expect(readLensValue(lens, ann, 'meta.constructor')).toEqual({ ok: true, value: 'own' });
    expect(readLensValue(lens, ann, 'meta.a.toString')).toEqual({ ok: true, value: undefined });
  });

  test('a related row its clamp hides reads null, at every depth below it', () => {
    expect(readLensValue(lens, bob, 'org.name')).toEqual({ ok: true, value: null });
    expect(readLensValue(lens, bob, 'org.parent.name')).toEqual({ ok: true, value: null });
  });

  test("a row the lens's own clamp hides reads null", () => {
    const annOnly: LensNarrowing = {
      parent: lens,
      root: { where: { field: 'id', operator: 'equals', value: 1 } },
    };
    expect(readLensValue(annOnly, ann, 'name')).toEqual({ ok: true, value: 'Ann' });
    expect(readLensValue(annOnly, bob, 'name')).toEqual({ ok: true, value: null });
  });

  test('a missing related row reads null', () => {
    expect(readLensValue(lens, { ...ann, org: null }, 'org.name')).toEqual({
      ok: true,
      value: null,
    });
  });

  test('a column the lens hides is refused, never read', () => {
    expect(readLensValue(lens, ann, 'score')).toEqual({ ok: false, reason: 'hidden' });
    expect(readLensValue(lens, ann, 'org.seats')).toEqual({ ok: false, reason: 'hidden' });
  });

  test('a path the model lacks, or past a column, is refused', () => {
    expect(readLensValue(lens, ann, 'nope')).toEqual({ ok: false, reason: 'missing' });
    expect(readLensValue(lens, ann, 'name.length')).toEqual({ ok: false, reason: 'pastScalar' });
  });

  test('a relation is rows, not a value: ending on one, or crossing a list, is refused', () => {
    expect(readLensValue(lens, ann, 'org')).toEqual({ ok: false, reason: 'relation' });
    expect(readLensValue(lens, ann, 'posts.title')).toEqual({ ok: false, reason: 'list' });
  });

  test('a relation the lens does not turn on is hidden, never read', () => {
    expect(readLensValue(lens, ann, 'org.parent.parent.name')).toEqual({
      ok: false,
      reason: 'hidden',
    });
  });
});
