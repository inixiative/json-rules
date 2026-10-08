import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge, FieldMap } from '../src/fieldMap/types';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { validateRuleInLens } from '../src/lens/validateRuleInLens';
import { Operator } from '../src/operator';

const prismaMap: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        crmId: { kind: 'scalar', type: 'String' },
        fanMissions: { kind: 'object', type: 'FanMission', isList: true },
      },
    },
    FanMission: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        missionUuid: { kind: 'scalar', type: 'String' },
        status: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const salesforceMap: FieldMap = {
  models: {
    Contact: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        industry: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact', on: 'id' },
    { fieldMap: 'prisma', model: 'FanUser', on: 'crmId' },
  ],
  cardinality: 'oneToMany',
};

const stitched = stitchFieldMaps({
  maps: { prisma: prismaMap, salesforce: salesforceMap },
  bridges: [bridge],
});

const lens: Lens = {
  ...stitched,
  mapName: 'prisma',
  model: 'FanUser',
};

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('validateRuleInLens', () => {
  test('rule fully within unrestricted lens passes', () => {
    const result = validateRuleInLens(
      { field: 'email', operator: Operator.equals, value: 'x' },
      lens,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('rule referencing non-existent field fails', () => {
    const result = validateRuleInLens(
      { field: 'nope', operator: Operator.equals, value: 'x' },
      lens,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('nope');
  });

  test('rule referencing omitted field fails after narrowing', () => {
    const n = withParent(lens, { root: { omits: ['email'] } });
    const result = validateRuleInLens({ field: 'email', operator: Operator.equals, value: 'x' }, n);
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('email');
  });

  test('rule referencing un-picked field fails after pick narrowing', () => {
    const n = withParent(lens, { root: { picks: ['email'] } });
    const result = validateRuleInLens({ field: 'name', operator: Operator.equals, value: 'x' }, n);
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('name');
  });

  test('AND rule collects violations for all bad branches', () => {
    const n = withParent(lens, { root: { picks: ['email'] } });
    const result = validateRuleInLens(
      {
        all: [
          { field: 'email', operator: Operator.equals, value: 'x' },
          { field: 'name', operator: Operator.equals, value: 'x' },
          { field: 'id', operator: Operator.equals, value: 'x' },
        ],
      },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.errors.map((v) => v.path).sort()).toEqual(['id', 'name']);
  });

  test('rule traversing a relation that remains picked passes', () => {
    const n = withParent(lens, {
      root: {
        picks: ['email'],
        relations: { fanMissions: { picks: ['missionUuid'] } },
      },
    });
    const result = validateRuleInLens(
      { field: 'fanMissions.missionUuid', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(true);
  });

  test('rule traversing into un-picked nested field fails', () => {
    const n = withParent(lens, {
      root: {
        relations: { fanMissions: { picks: ['missionUuid'] } },
      },
    });
    const result = validateRuleInLens(
      { field: 'fanMissions.status', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('fanMissions.status');
  });

  test('cross-map bridge path passes when narrowed in', () => {
    const n = withParent(lens, {
      root: {
        relations: { 'salesforce:Contact': { picks: ['industry'] } },
      },
    });
    const result = validateRuleInLens(
      { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(true);
  });

  test('rule traversing a relation that is off fails', () => {
    for (const field of ['fanMissions.missionUuid', 'salesforce:Contact.industry']) {
      const result = validateRuleInLens({ field, operator: Operator.equals, value: 'x' }, lens);
      expect(result.errors.map((v) => [v.path, v.code])).toEqual([[field, 'not_in_lens']]);
    }
  });

  const missions = withParent(lens, { root: { relations: { fanMissions: {} } } });

  test('arrayRule inner condition resolves against relation target (not anchor)', () => {
    const result = validateRuleInLens(
      {
        field: 'fanMissions',
        arrayOperator: 'any',
        condition: { field: 'missionUuid', operator: Operator.equals, value: 'x' },
      } as never,
      missions,
    );
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('arrayRule inner condition catches bogus field on relation target', () => {
    const result = validateRuleInLens(
      {
        field: 'fanMissions',
        arrayOperator: 'any',
        condition: { field: 'ghostField', operator: Operator.equals, value: 'x' },
      } as never,
      missions,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('ghostField');
  });

  test('cross-map bridge path fails when un-picked', () => {
    const n = withParent(lens, {
      root: {
        relations: { 'salesforce:Contact': { picks: ['industry'] } },
      },
    });
    const result = validateRuleInLens(
      { field: 'salesforce:Contact.id', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].path).toBe('salesforce:Contact.id');
  });
});
