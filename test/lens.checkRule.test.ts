import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      name: { kind: 'scalar', type: 'String' },
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
};

const salesforceMap: FieldMap = {
  Contact: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      industry: { kind: 'scalar', type: 'String' },
    },
  },
};

const bridge: Bridge = {
  endpoints: [
    { fieldMap: 'salesforce', model: 'Contact' },
    { fieldMap: 'prisma', model: 'FanUser' },
  ],
  cardinality: 'oneToMany',
};

const stitched = stitchFieldMaps({ prisma: prismaMap, salesforce: salesforceMap }, [bridge]);

const lens: Lens = {
  map: stitched,
  mapName: 'prisma',
  model: 'FanUser',
};

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

describe('checkRuleAgainstLens', () => {
  test('rule fully within unrestricted lens passes', () => {
    const result = checkRuleAgainstLens(
      { field: 'email', operator: Operator.equals, value: 'x' },
      lens,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('rule referencing non-existent field fails', () => {
    const result = checkRuleAgainstLens(
      { field: 'nope', operator: Operator.equals, value: 'x' },
      lens,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('nope');
  });

  test('rule referencing omitted field fails after narrowing', () => {
    const n = withParent(lens, {
      prisma: { models: { FanUser: { omits: ['email'] } } },
    });
    const result = checkRuleAgainstLens(
      { field: 'email', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('email');
  });

  test('rule referencing un-picked field fails after pick narrowing', () => {
    const n = withParent(lens, {
      prisma: { models: { FanUser: { picks: ['email'] } } },
    });
    const result = checkRuleAgainstLens(
      { field: 'name', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('name');
  });

  test('AND rule collects violations for all bad branches', () => {
    const n = withParent(lens, {
      prisma: { models: { FanUser: { picks: ['email'] } } },
    });
    const result = checkRuleAgainstLens(
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
    expect(result.violations.map((v) => v.path).sort()).toEqual(['id', 'name']);
  });

  test('rule traversing a relation that remains picked passes', () => {
    const n = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            picks: ['email'],
            relations: { fanMissions: { picks: ['missionUuid'] } },
          },
        },
      },
    });
    const result = checkRuleAgainstLens(
      { field: 'fanMissions.missionUuid', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(true);
  });

  test('rule traversing into un-picked nested field fails', () => {
    const n = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            relations: { fanMissions: { picks: ['missionUuid'] } },
          },
        },
      },
    });
    const result = checkRuleAgainstLens(
      { field: 'fanMissions.status', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('fanMissions.status');
  });

  test('cross-map bridge path passes when narrowed in', () => {
    const n = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            relations: { 'salesforce:Contact': { picks: ['industry'] } },
          },
        },
      },
    });
    const result = checkRuleAgainstLens(
      { field: 'salesforce:Contact.industry', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(true);
  });

  test('cross-map bridge path fails when un-picked', () => {
    const n = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            relations: { 'salesforce:Contact': { picks: ['industry'] } },
          },
        },
      },
    });
    const result = checkRuleAgainstLens(
      { field: 'salesforce:Contact.id', operator: Operator.equals, value: 'x' },
      n,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0].path).toBe('salesforce:Contact.id');
  });
});
