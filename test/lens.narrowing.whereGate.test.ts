import { describe, expect, test } from 'bun:test';
import { validateNarrowing } from '../src/lens/narrowing';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { ArrayOperator, Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Every `where` a layer declares is a grant its author gets to filter rows by. `root.where`
// has always been validated against the PARENT surface (a child may not filter on a column an
// ancestor hid — that is a value oracle over hidden data). The other where positions —
// `root.relations[..].where`, `mapDefaults[..].models[..].where`, and `sources` wheres — went
// through a model-local "top segment exists" check instead, which both leaked (ancestor-hidden
// fields and enum values accepted) and false-rejected legitimate nested relation conditions.
// One lens-aware walk at the where's anchor visit, against the parent policy, closes both.

const map: FieldMap = {
  models: {
    Customer: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        internalScore: { kind: 'scalar', type: 'Int' },
        tier: { kind: 'enum', type: 'Tier' },
        orders: { kind: 'object', type: 'Order', isList: true },
        account: { kind: 'object', type: 'Account' },
      },
    },
    Order: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        status: { kind: 'scalar', type: 'String' },
        secretMargin: { kind: 'scalar', type: 'Int' },
      },
    },
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        region: { kind: 'scalar', type: 'String' },
      },
    },
  },
  enums: { Tier: ['gold', 'silver', 'internal'] },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'Customer' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

const marginOver50 = { field: 'secretMargin', operator: Operator.greaterThan, value: 50 };

describe('validateNarrowing — every where position is gated against the parent surface', () => {
  test('a model default cannot bypass an ancestor path-specific omission', () => {
    const platform = withParent(lens, {
      root: { relations: { orders: { omits: ['secretMargin'] } } },
    });
    expect(() =>
      validateNarrowing(
        withParent(platform, {
          mapDefaults: { prisma: { models: { Order: { where: marginOver50 } } } },
        }),
      ),
    ).toThrow(/secretMargin.*does not resolve/);
  });

  test('a relation where comparison reference is checked at the related model', () => {
    const platform = withParent(lens, {
      root: { relations: { orders: { omits: ['secretMargin'] } } },
    });
    expect(() =>
      validateNarrowing(
        withParent(platform, {
          root: {
            relations: {
              orders: {
                where: {
                  field: 'id',
                  operator: Operator.equals,
                  path: 'secretMargin',
                },
              },
            },
          },
        }),
      ),
    ).toThrow(/secretMargin.*comparison ref/);
  });
  test('root.relations[R].where on a field the ancestor hid at that path → error', () => {
    const platform = withParent(lens, {
      root: { relations: { orders: { omits: ['secretMargin'] } } },
    });
    const org = withParent(platform, {
      root: { relations: { orders: { where: marginOver50 } } },
    });
    expect(() => validateNarrowing(org)).toThrow(
      /root\.relations\.orders\.where: 'secretMargin' .*does not resolve/,
    );
  });

  test('mapDefaults.models[M].where on a field the ancestor mapDefaults hid → error', () => {
    const platform = withParent(lens, {
      mapDefaults: { prisma: { models: { Order: { omits: ['secretMargin'] } } } },
    });
    const org = withParent(platform, {
      mapDefaults: { prisma: { models: { Order: { where: marginOver50 } } } },
    });
    expect(() => validateNarrowing(org)).toThrow(
      /mapDefaults\.prisma\.models\.Order\.where: 'secretMargin' .*does not resolve/,
    );
  });

  test('mapDefaults.models[M].where naming an enum value the ancestor removed → error', () => {
    const platform = withParent(lens, {
      mapDefaults: { prisma: { enums: { Tier: { omits: ['internal'] } } } },
    });
    const org = withParent(platform, {
      mapDefaults: {
        prisma: {
          models: {
            Customer: { where: { field: 'tier', operator: Operator.equals, value: 'internal' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(org)).toThrow(
      /Customer\.where: .*'internal' is not in the allowed set/,
    );
  });

  test('a sources where on a field the ancestor hid → error', () => {
    const platform = withParent(lens, {
      mapDefaults: { prisma: { models: { Order: { omits: ['secretMargin'] } } } },
    });
    const org = withParent(platform, {
      mapDefaults: { prisma: { models: { Order: { sources: { status: marginOver50 } } } } },
    });
    expect(() => validateNarrowing(org)).toThrow(
      /mapDefaults\.prisma\.models\.Order\.sources\.status: 'secretMargin' .*does not resolve/,
    );
  });

  test('root.where on an ancestor-hidden field still errors (unchanged)', () => {
    const platform = withParent(lens, { root: { omits: ['internalScore'] } });
    const org = withParent(platform, {
      root: { where: { field: 'internalScore', operator: Operator.greaterThan, value: 1 } },
    });
    expect(() => validateNarrowing(org)).toThrow(/root\.where: 'internalScore' .*does not resolve/);
  });
});

describe('validateNarrowing — where paths resolve through relations, not against the anchor model', () => {
  test('a mapDefaults where with a nested relation condition is accepted', () => {
    // Previously rejected: "'status' not on model Customer" — the nested condition was
    // checked against Customer instead of the descended Order.
    const n = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: {
            Customer: {
              where: {
                field: 'orders',
                arrayOperator: ArrayOperator.any,
                condition: { field: 'status', operator: Operator.equals, value: 'paid' },
              },
            },
          },
        },
      },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });

  test('a relation-node where with a bogus nested field → error at the descended model', () => {
    const n = withParent(lens, {
      root: {
        where: {
          field: 'orders',
          arrayOperator: ArrayOperator.any,
          condition: { field: 'nope', operator: Operator.equals, value: 'x' },
        },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/root\.where: 'nope' .*does not resolve/);
  });

  test('a dotted to-one path resolves; a bogus tail is rejected', () => {
    const ok = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: {
            Customer: {
              where: { field: 'account.region', operator: Operator.equals, value: 'us' },
            },
          },
        },
      },
    });
    expect(() => validateNarrowing(ok)).not.toThrow();

    const bad = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: {
            Customer: { where: { field: 'account.nope', operator: Operator.equals, value: 'us' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(bad)).toThrow(
      /Customer\.where: 'account\.nope' .*does not resolve/,
    );
  });

  test('a where may still name a field the SAME layer hides (validated against the parent)', () => {
    const n = withParent(lens, {
      mapDefaults: {
        prisma: { models: { Order: { omits: ['secretMargin'], where: marginOver50 } } },
      },
    });
    expect(() => validateNarrowing(n)).not.toThrow();
  });

  test('a mapDefaults where on a model that is not the anchor validates against that model', () => {
    const n = withParent(lens, {
      mapDefaults: {
        prisma: {
          models: {
            // 'region' is on Account, not Order
            Order: { where: { field: 'region', operator: Operator.equals, value: 'us' } },
          },
        },
      },
    });
    expect(() => validateNarrowing(n)).toThrow(/Order\.where: 'region' .*does not resolve/);
  });
});
