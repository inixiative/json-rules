import { describe, expect, test } from 'bun:test';
import { stitchFieldMaps } from '../src/fieldMap/stitch';
import type { Bridge } from '../src/fieldMap/types';
import { validateNarrowing } from '../src/lens/narrowing';
import type { Lens, LensNarrowing, ModelNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';

const prismaMap: FieldMap = {
  FanUser: {
    fields: {
      id: { kind: 'scalar', type: 'String' },
      email: { kind: 'scalar', type: 'String' },
      name: { kind: 'scalar', type: 'String' },
      deletedAt: { kind: 'scalar', type: 'DateTime' },
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

describe('validateNarrowing — structural rules', () => {
  test('empty narrowing passes', () => {
    expect(() => validateNarrowing(withParent(lens, {}))).not.toThrow();
  });

  test('valid picks at root model pass', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { FanUser: { picks: ['email', 'name'] } } },
        }),
      ),
    ).not.toThrow();
  });

  test('picks + omits at same node throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { FanUser: { picks: ['email'], omits: ['name'] } } },
        }),
      ),
    ).toThrow(/cannot specify both picks and omits/);
  });

  test('pick referencing non-existent field throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { FanUser: { picks: ['nope'] } } },
        }),
      ),
    ).toThrow(/'nope' not on model/);
  });

  test('omit referencing non-existent field throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { FanUser: { omits: ['nope'] } } },
        }),
      ),
    ).toThrow(/'nope' not on model/);
  });

  test('relations key not on model throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { FanUser: { relations: { ghost: { picks: ['x'] } } } } },
        }),
      ),
    ).toThrow(/'ghost' not on model/);
  });

  test('relations key on scalar field throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { FanUser: { relations: { email: {} } } } },
        }),
      ),
    ).toThrow(/'email' is not a relation/);
  });

  test('unknown map name throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          nope: { models: { FanUser: {} } },
        }),
      ),
    ).toThrow(/maps\.nope: not in lens/);
  });

  test('unknown model name throws', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: { models: { Nope: {} } },
        }),
      ),
    ).toThrow(/models\.Nope: not in fieldMap/);
  });

  test('recurses into relation, validates against related model', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: {
            models: {
              FanUser: {
                relations: { fanMissions: { picks: ['missionUuid', 'status'] } },
              },
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  test('recursion catches invalid field on related model', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: {
            models: {
              FanUser: {
                relations: { fanMissions: { picks: ['nope'] } },
              },
            },
          },
        }),
      ),
    ).toThrow(/fanMissions\.picks: field 'nope' not on model/);
  });

  test('cross-map bridge relation resolves to target map', () => {
    expect(() =>
      validateNarrowing(
        withParent(lens, {
          prisma: {
            models: {
              FanUser: {
                relations: {
                  'salesforce:Contact': { picks: ['industry'] },
                },
              },
            },
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
          prisma: {
            models: {
              FanUser: { picks: ['nope1', 'nope2'], omits: ['alsoNope'] },
            },
          },
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
  const parentPicksOnFanUser = (picks: string[]): LensNarrowing =>
    withParent(lens, { prisma: { models: { FanUser: { picks } } } });

  const parentOmitsOnFanUser = (omits: string[]): LensNarrowing =>
    withParent(lens, { prisma: { models: { FanUser: { omits } } } });

  test('child pick within ancestor picks passes', () => {
    const parent = parentPicksOnFanUser(['email', 'name']);
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { picks: ['email'] } } } }),
      ),
    ).not.toThrow();
  });

  test('child pick outside ancestor picks throws', () => {
    const parent = parentPicksOnFanUser(['email']);
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { picks: ['name'] } } } }),
      ),
    ).toThrow(/'name' not in ancestor's picks/);
  });

  test('child cannot pick ancestor-omitted field', () => {
    const parent = parentOmitsOnFanUser(['email']);
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { picks: ['email'] } } } }),
      ),
    ).toThrow(/'email' was omitted by ancestor/);
  });

  test('child can switch from ancestor-omit context to its own pick (non-omitted field)', () => {
    const parent = parentOmitsOnFanUser(['email']);
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { picks: ['name'] } } } }),
      ),
    ).not.toThrow();
  });

  test('child can omit anything visible in ancestor picks', () => {
    const parent = parentPicksOnFanUser(['email', 'name']);
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { omits: ['email'] } } } }),
      ),
    ).not.toThrow();
  });

  test('child cannot omit field already invisible (not in ancestor picks)', () => {
    const parent = parentPicksOnFanUser(['email']);
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { omits: ['name'] } } } }),
      ),
    ).toThrow(/'name' not in ancestor's picks \(already invisible\)/);
  });

  test('chain rules recurse into relations', () => {
    const parent: LensNarrowing = withParent(lens, {
      prisma: {
        models: {
          FanUser: {
            relations: { fanMissions: { picks: ['missionUuid'] } },
          },
        },
      },
    });
    expect(() =>
      validateNarrowing(
        withParent(parent, {
          prisma: {
            models: {
              FanUser: {
                relations: { fanMissions: { picks: ['status'] } },
              },
            },
          },
        }),
      ),
    ).toThrow(/fanMissions\.picks: 'status' not in ancestor's picks/);
  });

  test('multi-level chain (grandparent → parent → child)', () => {
    const grandparent = parentPicksOnFanUser(['email', 'name', 'id']);
    const parent = withParent(grandparent, {
      prisma: { models: { FanUser: { picks: ['email', 'name'] } } },
    });
    expect(() =>
      validateNarrowing(
        withParent(parent, { prisma: { models: { FanUser: { picks: ['email'] } } } }),
      ),
    ).not.toThrow();

    expect(() =>
      validateNarrowing(withParent(parent, { prisma: { models: { FanUser: { picks: ['id'] } } } })),
    ).toThrow(/'id' not in ancestor's picks/);
  });
});
