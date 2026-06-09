import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { validateNarrowing } from '../src/lens/narrowing';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

const prismaMap: FieldMap = {
  models: {
    FanUser: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        deletedAt: { kind: 'scalar', type: 'DateTime' },
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

describe('validateNarrowing — structural rules', () => {
  test('empty narrowing passes', () => {
    expect(() => validateNarrowing(withParent(lens, {}))).not.toThrow();
  });

  test('valid picks at root pass', () => {
    expect(() =>
      validateNarrowing(withParent(lens, { root: { picks: ['email', 'name'] } })),
    ).not.toThrow();
  });

  test('picks + omits at same node throws', () => {
    expect(() =>
      validateNarrowing(withParent(lens, { root: { picks: ['email'], omits: ['name'] } })),
    ).toThrow(/cannot specify both picks and omits/);
  });

  test('pick referencing non-existent field throws', () => {
    expect(() => validateNarrowing(withParent(lens, { root: { picks: ['nope'] } }))).toThrow(
      /'nope' not on model/,
    );
  });

  test('omit referencing non-existent field throws', () => {
    expect(() => validateNarrowing(withParent(lens, { root: { omits: ['nope'] } }))).toThrow(
      /'nope' not on model/,
    );
  });

  test('relations key not on model throws', () => {
    expect(() =>
      validateNarrowing(withParent(lens, { root: { relations: { ghost: { picks: ['x'] } } } })),
    ).toThrow(/'ghost' not on model/);
  });

  test('relations key on scalar field throws', () => {
    expect(() =>
      validateNarrowing(withParent(lens, { root: { relations: { email: {} } } })),
    ).toThrow(/'email' is not a relation/);
  });

  test('unknown map name in mapDefaults throws', () => {
    expect(() =>
      validateNarrowing(withParent(lens, { mapDefaults: { nope: { models: { FanUser: {} } } } })),
    ).toThrow(/mapDefaults\.nope: not in lens/);
  });

  test('unknown model name in mapDefaults throws', () => {
    expect(() =>
      validateNarrowing(withParent(lens, { mapDefaults: { prisma: { models: { Nope: {} } } } })),
    ).toThrow(/Nope: not in fieldMap/);
  });

  test('recurses into relation, validates against related model', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          root: {
            relations: { fanMissions: { picks: ['missionUuid', 'status'] } },
          },
        }),
      ),
    ).not.toThrow();
  });

  test('recursion catches invalid field on related model', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          root: { relations: { fanMissions: { picks: ['nope'] } } },
        }),
      ),
    ).toThrow(/fanMissions\.picks: field 'nope' not on model/);
  });

  test('cross-map bridge relation resolves to target map', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          root: {
            relations: { 'salesforce:Contact': { picks: ['industry'] } },
          },
        }),
      ),
    ).not.toThrow();
  });

  test('accumulates multiple errors', () => {
    let err: Error | undefined;
    try {
      validateNarrowing(
        withParent(lens, {
          root: { picks: ['nope1', 'nope2'], omits: ['alsoNope'] },
        }),
      );
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).toContain('cannot specify both picks and omits');
    expect(err?.message).toContain('nope1');
    expect(err?.message).toContain('nope2');
    expect(err?.message).toContain('alsoNope');
  });
});

describe('validateNarrowing — chain rules', () => {
  const parentPicksOnRoot = (picks: string[]): LensNarrowing =>
    withParent(lens, { root: { picks } });

  const parentOmitsOnRoot = (omits: string[]): LensNarrowing =>
    withParent(lens, { root: { omits } });

  test('child pick within ancestor picks passes', () => {
    const parent = parentPicksOnRoot(['email', 'name']);
    expect(() =>
      validateNarrowing(withParent(parent, { root: { picks: ['email'] } })),
    ).not.toThrow();
  });

  test('child pick outside ancestor picks throws', () => {
    const parent = parentPicksOnRoot(['email']);
    expect(() => validateNarrowing(withParent(parent, { root: { picks: ['name'] } }))).toThrow(
      /'name' not in ancestor's picks/,
    );
  });

  test('child cannot pick ancestor-omitted field', () => {
    const parent = parentOmitsOnRoot(['email']);
    expect(() => validateNarrowing(withParent(parent, { root: { picks: ['email'] } }))).toThrow(
      /'email' was omitted by ancestor/,
    );
  });

  test('child can switch from ancestor-omit context to its own pick (non-omitted field)', () => {
    const parent = parentOmitsOnRoot(['email']);
    expect(() =>
      validateNarrowing(withParent(parent, { root: { picks: ['name'] } })),
    ).not.toThrow();
  });

  test('child can omit anything visible in ancestor picks', () => {
    const parent = parentPicksOnRoot(['email', 'name']);
    expect(() =>
      validateNarrowing(withParent(parent, { root: { omits: ['email'] } })),
    ).not.toThrow();
  });

  test('child cannot omit field already invisible (not in ancestor picks)', () => {
    const parent = parentPicksOnRoot(['email']);
    expect(() => validateNarrowing(withParent(parent, { root: { omits: ['name'] } }))).toThrow(
      /'name' not in ancestor's picks \(already invisible\)/,
    );
  });

  test('chain rules recurse into relations', () => {
    const parent: LensNarrowing = withParent(lens, {
      root: { relations: { fanMissions: { picks: ['missionUuid'] } } },
    });
    expect(() =>
      validateNarrowing(
        withParent(parent, {
          root: { relations: { fanMissions: { picks: ['status'] } } },
        }),
      ),
    ).toThrow(/fanMissions\.picks: 'status' not in ancestor's picks/);
  });

  test('multi-level chain (grandparent → parent → child)', () => {
    const grandparent = parentPicksOnRoot(['email', 'name', 'id']);
    const parent = withParent(grandparent, { root: { picks: ['email', 'name'] } });
    expect(() =>
      validateNarrowing(withParent(parent, { root: { picks: ['email'] } })),
    ).not.toThrow();

    expect(() => validateNarrowing(withParent(parent, { root: { picks: ['id'] } }))).toThrow(
      /'id' not in ancestor's picks/,
    );
  });
});

describe('validateNarrowing — root.where', () => {
  test('root.where referencing visible field passes', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { where: { field: 'email', operator: Operator.equals, value: 'x' } },
      }),
    ).not.toThrow();
  });

  test('root.where referencing a field this narrowing omits is OK (own omit narrows output, not where scope)', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: {
          omits: ['email'],
          where: { field: 'email', operator: Operator.equals, value: 'x' },
        },
      }),
    ).not.toThrow();
  });

  test("root.where referencing a field this narrowing doesn't pick is OK (validated against parent)", () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: {
          picks: ['id'],
          where: { field: 'email', operator: Operator.equals, value: 'x' },
        },
      }),
    ).not.toThrow();
  });

  test('root.where referencing field omitted by ancestor throws', () => {
    const parent: LensNarrowing = {
      parent: lens,
      root: { omits: ['email'] },
    };
    expect(() =>
      validateNarrowing({
        parent,
        root: { where: { field: 'email', operator: Operator.equals, value: 'x' } },
      }),
    ).toThrow(/where.*'email'/);
  });
});
