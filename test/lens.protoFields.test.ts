import { describe, expect, test } from 'bun:test';
import { checkRuleAgainstLens } from '../src/lens/checkRule';
import type { Lens } from '../src/lens/types';
import { walkPath } from '../src/lens/walk';
import { Operator } from '../src/operator';
import type { FieldMap } from '../src/toPrisma/types';

// Field maps are plain object literals, so a bare `fields[name]` resolves every
// Object.prototype member name as a truthy "entry" nobody declared — and the policy
// gate approved rules whose leaf check() then evaluates as unconditionally true
// (lodash get returns the Object constructor). Same hole class as the bind lookup
// fixed in 2.19.3; every field-map lookup is an own-property check.
const PROTO_NAMES = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        email: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const lens: Lens = {
  maps: { prisma: map },
  bridges: [],
  mapName: 'prisma',
  model: 'User',
} as never;

describe('prototype-named fields never resolve', () => {
  test('the policy gate rejects them like any other undeclared field', () => {
    expect(checkRuleAgainstLens({ field: 'email', operator: Operator.exists }, lens).ok).toBe(true);
    expect(checkRuleAgainstLens({ field: 'secret', operator: Operator.exists }, lens).ok).toBe(
      false,
    );
    for (const name of PROTO_NAMES) {
      expect(checkRuleAgainstLens({ field: name, operator: Operator.exists }, lens).ok).toBe(false);
    }
  });

  test('walkPath returns null for them', () => {
    const set = { maps: { prisma: map }, bridges: [] } as never;
    expect(walkPath(set, 'prisma', 'User', 'email')).not.toBeNull();
    for (const name of PROTO_NAMES) {
      expect(walkPath(set, 'prisma', 'User', name)).toBeNull();
    }
  });
});
