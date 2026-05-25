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

const withParent = (parent: Lens | LensNarrowing, maps: LensNarrowing['maps']): LensNarrowing => ({
  parent,
  maps,
});

describe('validateNarrowing — pick/omit inheritance strictness', () => {
  test('omits a field already excluded by defaults → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: {
          models: { User: { omits: ['password'] } },
          defaults: { models: { User: { omits: ['password'] } } },
        },
      },
    };
    expect(() => validateNarrowing(n)).toThrow(/password.*already.*excluded|not.*visible/i);
  });

  test('omits a field that was never visible (defaults.picks excluded it) → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: {
          models: { User: { omits: ['password'] } },
          defaults: { models: { User: { picks: ['id', 'email'] } } },
        },
      },
    };
    expect(() => validateNarrowing(n)).toThrow(/password.*not.*visible|not.*in.*picks/i);
  });

  test('picks a field excluded by an ancestor → error', () => {
    const parent = withParent(lens, {
      prisma: { models: { User: { picks: ['id', 'email'] } } },
    });
    const child: LensNarrowing = {
      parent,
      maps: {
        prisma: { models: { User: { picks: ['password'] } } },
      },
    };
    expect(() => validateNarrowing(child)).toThrow(/password.*not.*visible|not.*in/i);
  });

  test('picks a field visible from defaults → OK', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: {
            models: { User: { picks: ['id'] } },
            defaults: { models: { User: { picks: ['id', 'email'] } } },
          },
        },
      }),
    ).not.toThrow();
  });

  test('omits a field still visible from defaults → OK', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: {
            models: { User: { omits: ['email'] } },
            defaults: { models: { User: { picks: ['id', 'email', 'name'] } } },
          },
        },
      }),
    ).not.toThrow();
  });
});

describe('validateNarrowing — enum inheritance strictness', () => {
  test('enumPicks references value already excluded by defaults.enums → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: {
          models: { User: { enumPicks: { role: ['admin', 'guest'] } } },
          defaults: { enums: { UserRole: { omits: ['guest'] } } },
        },
      },
    };
    expect(() => validateNarrowing(n)).toThrow(
      /guest.*(not.*allowed|not.*visible|already.*excluded)/i,
    );
  });

  test('enumOmits references value already excluded by defaults.enums → error', () => {
    const n: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: {
          models: { User: { enumOmits: { role: ['guest'] } } },
          defaults: { enums: { UserRole: { omits: ['guest'] } } },
        },
      },
    };
    expect(() => validateNarrowing(n)).toThrow(/guest.*already.*excluded|not.*visible/i);
  });

  test('enumPicks subset of inherited set → OK', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: {
            models: { User: { enumPicks: { role: ['admin'] } } },
            defaults: { enums: { UserRole: { picks: ['admin', 'member'] } } },
          },
        },
      }),
    ).not.toThrow();
  });

  test('enumPicks references an unknown enum value (not in registry) → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: { models: { User: { enumPicks: { role: ['SUPERVISOR'] } } } },
        },
      }),
    ).toThrow(/SUPERVISOR|unknown.*value/i);
  });

  test('enumPicks on a non-enum field → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: { models: { User: { enumPicks: { email: ['x'] } } } },
        },
      }),
    ).toThrow(/email.*not.*enum|not.*enum.*field/i);
  });
});

describe('validateNarrowing — where anchoring', () => {
  test('defaults.models[M].where paths validated against model M', () => {
    // Constrains references User field, declared at defaults.models.User → OK
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: {
            models: {},
            defaults: {
              models: {
                User: {
                  where: { field: 'email', operator: Operator.equals, value: 'x' },
                },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test('defaults.models[M].where referencing a field not on model M → error', () => {
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: {
            models: {},
            defaults: {
              models: {
                User: {
                  // 'title' is on Post, not User
                  where: { field: 'title', operator: Operator.equals, value: 'x' },
                },
              },
            },
          },
        },
      }),
    ).toThrow(/title|not.*on.*User/i);
  });

  test('relations[R].where validated against R target model', () => {
    // posts → Post. Constrain references Post.title → OK
    expect(() =>
      validateNarrowing({
        parent: lens,
        maps: {
          prisma: {
            models: {
              User: {
                relations: {
                  posts: {
                    where: { field: 'title', operator: Operator.equals, value: 'x' },
                  },
                },
              },
            },
          },
        },
      }),
    ).not.toThrow();
  });
});

describe('validateNarrowing — ModelDefaultNarrowing rejects relations field', () => {
  test('declaring `relations` inside defaults.models[M] → error', () => {
    // Type system rejects this at compile time, but runtime check is safety net.
    const bad: LensNarrowing = {
      parent: lens,
      maps: {
        prisma: {
          models: {},
          defaults: {
            models: {
              // biome-ignore lint/suspicious/noExplicitAny: testing runtime safety net
              User: { relations: { posts: { picks: ['id'] } } } as any,
            },
          },
        },
      },
    };
    expect(() => validateNarrowing(bad)).toThrow(
      /relations.*not.*allowed.*default|defaults.*cannot.*relations/i,
    );
  });
});
