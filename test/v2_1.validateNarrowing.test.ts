import { describe, expect, test } from 'bun:test';
import { validateNarrowing } from '../src/lens/narrowing';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Strict narrowing validation rules (v2.1):
// Each narrowing layer can only mention fields/enum-values that remain visible
// from the layers above it. Catches developer errors loudly at construction
// instead of silently producing empty effective sets.

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
        password: { kind: 'scalar', type: 'String' },
        role: { kind: 'enum', type: 'UserRole' },
        posts: { kind: 'object', type: 'Post', isList: true },
      },
    },
    Post: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        title: { kind: 'scalar', type: 'String' },
      },
    },
  },
  enums: { UserRole: ['admin', 'member', 'owner', 'guest'] },
};
const lens: Lens = { maps: { prisma: map }, mapName: 'prisma', model: 'User' };

const withParent = (
  parent: Lens | LensNarrowing,
  rest: Omit<LensNarrowing, 'parent'>,
): LensNarrowing => ({ parent, ...rest });

describe('validateNarrowing — pick/omit inheritance strictness', () => {
  test('omits a field already excluded by defaults → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      root: { omits: ['password'] },
      mapDefaults: { prisma: { models: { User: { omits: ['password'] } } } },
    };
    expect(() => validateNarrowing(n)).toThrow(/password.*already.*excluded|not.*visible/i);
  });

  test('omits a field that was never visible (defaults.picks excluded it) → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      root: { omits: ['password'] },
      mapDefaults: { prisma: { models: { User: { picks: ['id', 'email'] } } } },
    };
    expect(() => validateNarrowing(n)).toThrow(/password.*not.*visible|not.*in.*picks/i);
  });

  test('picks a field excluded by an ancestor → error', () => {
    const parent = withParent(lens, {
      root: { picks: ['id', 'email'] },
    });
    const child: LensNarrowing = {
      parent,
      root: { picks: ['password'] },
    };
    expect(() => validateNarrowing(child)).toThrow(/password.*not.*visible|not.*in/i);
  });

  test('picks a field visible from defaults → OK', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { picks: ['id'] },
        mapDefaults: { prisma: { models: { User: { picks: ['id', 'email'] } } } },
      }),
    ).not.toThrow();
  });

  test('omits a field still visible from defaults → OK', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { omits: ['email'] },
        mapDefaults: { prisma: { models: { User: { picks: ['id', 'email', 'name'] } } } },
      }),
    ).not.toThrow();
  });
});

describe('validateNarrowing — enum inheritance strictness', () => {
  test('enumPicks references value already excluded by mapDefaults.enums → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      root: { enumPicks: { role: ['admin', 'guest'] } },
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['guest'] } } } },
    };
    expect(() => validateNarrowing(n)).toThrow(
      /guest.*(not.*allowed|not.*visible|already.*excluded)/i,
    );
  });

  test('enumOmits references value already excluded by mapDefaults.enums → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      root: { enumOmits: { role: ['guest'] } },
      mapDefaults: { prisma: { enums: { UserRole: { omits: ['guest'] } } } },
    };
    expect(() => validateNarrowing(n)).toThrow(/guest.*already.*excluded|not.*visible/i);
  });

  test('enumPicks subset of inherited set → OK', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { enumPicks: { role: ['admin'] } },
        mapDefaults: { prisma: { enums: { UserRole: { picks: ['admin', 'member'] } } } },
      }),
    ).not.toThrow();
  });

  test('enumPicks references an unknown enum value (not in registry) → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { enumPicks: { role: ['SUPERVISOR'] } },
      }),
    ).toThrow(/SUPERVISOR|unknown.*value/i);
  });

  test('enumPicks on a non-enum field → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { enumPicks: { email: ['x'] } },
      }),
    ).toThrow(/email.*not.*enum|not.*enum.*field/i);
  });
});

describe('validateNarrowing — where anchoring', () => {
  test('mapDefaults.models[M].where paths validated against model M', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        mapDefaults: {
          prisma: {
            models: {
              User: {
                where: { field: 'email', operator: Operator.equals, value: 'x' },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test('mapDefaults.models[M].where referencing a field not on model M → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        mapDefaults: {
          prisma: {
            models: {
              User: {
                // 'title' is on Post, not User
                where: { field: 'title', operator: Operator.equals, value: 'x' },
              },
            },
          },
        },
      }),
    ).toThrow(/title|not.*on.*User/i);
  });

  test('root.relations[R].where validated against R target model', () => {
    // posts → Post. where references Post.title → OK
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: {
          relations: {
            posts: {
              where: { field: 'title', operator: Operator.equals, value: 'x' },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test('root.where validated against the lens anchor model', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { where: { field: 'email', operator: Operator.equals, value: 'x' } },
      }),
    ).not.toThrow();

    expect(() =>
      validateNarrowing({
        parent: lens,
        // 'title' is on Post, not User (the lens anchor)
        root: { where: { field: 'title', operator: Operator.equals, value: 'x' } },
      }),
    ).toThrow(/title|not.*on.*User/i);
  });
});

describe('validateNarrowing — enum cross-layer strictness (2.2.0)', () => {
  test('root.enumPicks references value already excluded by same-layer mapDefaults.models[lens.model].enumOmits → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { enumPicks: { role: ['admin', 'owner'] } },
        mapDefaults: { prisma: { models: { User: { enumOmits: { role: ['owner'] } } } } },
      }),
    ).toThrow(/owner.*(already.*excluded|not.*allowed)/i);
  });

  test('root.enumPicks references value already excluded by ancestor mapDefaults.models[lens.model].enumOmits → error', () => {
    const parent: LensNarrowing = {
      parent: lens,
      mapDefaults: { prisma: { models: { User: { enumOmits: { role: ['owner'] } } } } },
    };
    expect(() =>
      validateNarrowing({
        parent,
        root: { enumPicks: { role: ['admin', 'owner'] } },
      }),
    ).toThrow(/owner.*(already.*excluded|not.*allowed)/i);
  });

  test('root.enumPicks references value not in ancestor root.enumPicks (same-position chain) → error', () => {
    const parent: LensNarrowing = {
      parent: lens,
      root: { enumPicks: { role: ['admin', 'member'] } },
    };
    expect(() =>
      validateNarrowing({
        parent,
        root: { enumPicks: { role: ['admin', 'owner'] } },
      }),
    ).toThrow(/owner.*(not.*allowed|already.*excluded)/i);
  });

  test('all three layers consistent → OK (admin allowed by enums, model defaults, and root picks)', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        root: { enumPicks: { role: ['admin'] } },
        mapDefaults: {
          prisma: {
            enums: { UserRole: { omits: ['guest'] } },
            models: { User: { enumOmits: { role: ['owner'] } } },
          },
        },
      }),
    ).not.toThrow();
  });
});

describe('validateNarrowing — ModelDefaultNarrowing rejects relations field', () => {
  test('declaring `relations` inside mapDefaults.models[M] → error', () => {
    // Type system rejects this at compile time, but runtime check is safety net.
    const bad: LensNarrowing = {
      parent: lens,
      mapDefaults: {
        prisma: {
          models: {
            // biome-ignore lint/suspicious/noExplicitAny: testing runtime safety net
            User: { relations: { posts: { picks: ['id'] } } } as any,
          },
        },
      },
    };
    expect(() => validateNarrowing(bad)).toThrow(
      /relations.*not.*allowed.*default|defaults.*cannot.*relations/i,
    );
  });
});
