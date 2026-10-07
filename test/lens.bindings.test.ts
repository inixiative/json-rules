import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '../src/fieldMap/types';
import { bindLens, listLensBindings } from '../src/lens/bindings';
import { assertValidNarrowing } from '../src/lens/narrowing';
import { narrowRule } from '../src/lens/narrowRule';
import { projectPaths } from '../src/lens/projectPaths';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        brandUuid: { kind: 'scalar', type: 'String' },
        region: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
      },
    },
  },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'FanUser' };
const rule: Condition = { field: 'tier', operator: Operator.equals, value: 'gold' };

const brandBind: Condition = { field: 'brandUuid', operator: Operator.equals, bind: 'brandUuid' };
const regionBind: Condition = { field: 'region', operator: Operator.equals, bind: 'region' };

describe('bindLens — preprocess binds into the lens', () => {
  test('a bare lens carries no binds and is returned as-is', () => {
    expect(bindLens(lens, { brandUuid: 'acme-1' })).toBe(lens);
    expect(listLensBindings(lens)).toEqual([]);
  });

  test('resolves a root.where bind, then narrowRule is fully concrete', () => {
    const n: LensNarrowing = { parent: lens, root: { where: brandBind } };
    expect(listLensBindings(n)).toEqual(['brandUuid']);

    const resolved = bindLens(n, { brandUuid: 'acme-1' });
    expect(listLensBindings(resolved)).toEqual([]);
    expect(narrowRule(rule, resolved)).toEqual({
      all: [{ field: 'brandUuid', operator: Operator.equals, value: 'acme-1' }, rule],
    });
  });

  test('partial — covers what the map has, leaves the rest as tokens', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = { parent: a, root: { where: regionBind } };
    expect(listLensBindings(b)).toEqual(['brandUuid', 'region']);

    const partial = bindLens(b, { brandUuid: 'acme-1' });
    expect(listLensBindings(partial)).toEqual(['region']);
    expect(narrowRule(rule, partial)).toEqual({
      all: [{ field: 'brandUuid', operator: Operator.equals, value: 'acme-1' }, regionBind, rule],
    });
  });

  test('resolves binds in a source eligibility where (toSourceQueries/projection see concrete)', () => {
    const n: LensNarrowing = { parent: lens, root: { sources: { tier: brandBind } } };
    const resolved = bindLens(n, { brandUuid: 'acme-1' });
    expect(projectPaths(resolved).FanUser?.sources.tier).toEqual([
      { field: 'brandUuid', operator: Operator.equals, value: 'acme-1' },
    ]);
  });

  test('does not mutate the input lens', () => {
    const n: LensNarrowing = { parent: lens, root: { where: brandBind } };
    bindLens(n, { brandUuid: 'acme-1' });
    expect(n.root?.where).toEqual(brandBind);
  });
});

describe('bind-name discipline — unique names + parent:', () => {
  test('a child re-declaring an ancestor bind name is rejected', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = {
      parent: a,
      root: { where: { field: 'region', operator: Operator.equals, bind: 'brandUuid' } },
    };
    expect(() => assertValidNarrowing(b)).toThrow(/already declared by an ancestor/);
  });

  test('parent:name references an inherited binding read-only — no collision, draws the same value', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = {
      parent: a,
      root: { where: { field: 'region', operator: Operator.equals, bind: 'parent:brandUuid' } },
    };
    expect(() => assertValidNarrowing(b)).not.toThrow();
    expect(listLensBindings(b)).toEqual(['brandUuid']);

    const resolved = bindLens(b, { brandUuid: 'acme-1' });
    expect(narrowRule(rule, resolved)).toEqual({
      all: [
        { field: 'brandUuid', operator: Operator.equals, value: 'acme-1' },
        { field: 'region', operator: Operator.equals, value: 'acme-1' },
        rule,
      ],
    });
  });

  test('a parent: reference no ancestor declares is rejected', () => {
    const b: LensNarrowing = {
      parent: lens,
      root: { where: { field: 'region', operator: Operator.equals, bind: 'parent:brandUuid' } },
    };
    expect(() => assertValidNarrowing(b)).toThrow(/no ancestor declares/);
  });
});

describe('bindOptional through a lens', () => {
  const optionalRegion: Condition = {
    field: 'region',
    operator: Operator.equals,
    bind: 'region',
    bindOptional: true,
  };

  test('listLensBindings leaves an optional name out', () => {
    const a: LensNarrowing = {
      parent: lens,
      root: { where: { all: [brandBind, optionalRegion] } },
    };
    expect(listLensBindings(a)).toEqual(['brandUuid']);
  });

  test('an optional name still collides with an ancestor declaration', () => {
    const a: LensNarrowing = { parent: lens, root: { where: brandBind } };
    const b: LensNarrowing = {
      parent: a,
      root: {
        where: {
          field: 'region',
          operator: Operator.equals,
          bind: 'brandUuid',
          bindOptional: true,
        },
      },
    };
    expect(() => assertValidNarrowing(b)).toThrow(/already declared by an ancestor/);
  });

  test('an unsupplied optional token survives resolution and applies as null', () => {
    const a: LensNarrowing = { parent: lens, root: { where: optionalRegion } };
    const resolved = bindLens(a, {});
    expect(narrowRule(rule, resolved)).toEqual({ all: [optionalRegion, rule] });
  });
});
