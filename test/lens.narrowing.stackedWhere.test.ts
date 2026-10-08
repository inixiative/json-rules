import { describe, expect, test } from 'bun:test';
import { check } from '../src/check';
import type { FieldMapSet } from '../src/fieldMap/types';
import { narrowRule } from '../src/lens/narrowRule';
import { projectPaths } from '../src/lens/projectPaths';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { Operator } from '../src/operator';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
          tagAttachments: {
            kind: 'object',
            type: 'TagAttachment',
            isList: true,
            relationName: 'UserTags',
            fromFields: [],
            toFields: [],
          },
        },
      },
      TagAttachment: {
        fields: {
          deletedAt: { kind: 'scalar', type: 'DateTime' },
          tag: {
            kind: 'object',
            type: 'Tag',
            relationName: 'AttachmentTag',
            fromFields: [],
            toFields: [],
          },
        },
      },
      Tag: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          name: { kind: 'scalar', type: 'String' },
          ownerModel: { kind: 'scalar', type: 'String' },
          organizationId: { kind: 'scalar', type: 'String' },
        },
      },
    },
  },
};

const base: Lens = { maps, mapName: 'app', model: 'User' };

// Layer 1 — the projection: which relations exist and that attachments are live.
const projection: LensNarrowing = {
  parent: base,
  root: {
    picks: ['id', 'name'],
    relations: {
      tagAttachments: {
        picks: [],
        where: { field: 'deletedAt', operator: Operator.notExists },
        relations: { tag: { picks: ['id', 'name'] } },
      },
    },
  },
};

// Layer 2 — the owner scope, as a model default: tags are platform or org-1's.
const scoped: LensNarrowing = {
  parent: projection,
  mapDefaults: {
    app: {
      models: {
        Tag: {
          where: {
            any: [
              { field: 'ownerModel', operator: Operator.equals, value: 'platform' },
              { field: 'organizationId', operator: Operator.equals, value: 'org-1' },
            ],
          },
        },
      },
    },
  },
};

// Layer 3 — the target: one recipient.
const targeted: LensNarrowing = {
  parent: scoped,
  root: { where: { field: 'id', operator: Operator.equals, value: 'u1' } },
};

const attachment = (deletedAt: string | null, tag: Record<string, unknown>) => ({ deletedAt, tag });

describe("stacked narrowings — every layer's where reaches the projection and the composed rule", () => {
  test('projectPaths carries the where of each layer at the visit it narrows', () => {
    const byPath = projectPaths(targeted);
    expect(byPath.User?.whereClauses).toEqual([
      { field: 'id', operator: Operator.equals, value: 'u1' },
    ]);
    expect(byPath['User.tagAttachments']?.whereClauses).toEqual([
      { field: 'deletedAt', operator: Operator.notExists },
    ]);
    expect(byPath['User.tagAttachments.tag']?.whereClauses).toHaveLength(1);
    expect(byPath['User.tagAttachments.tag']?.fields).toHaveProperty('name');
    expect(byPath['User.tagAttachments.tag']?.fields).not.toHaveProperty('organizationId');
  });

  test('a layer added later ANDs with an earlier where on the same visit — neither replaces the other', () => {
    const twice: LensNarrowing = {
      parent: targeted,
      root: { where: { field: 'name', operator: Operator.equals, value: 'Ann' } },
    };
    expect(projectPaths(twice).User?.whereClauses).toEqual([
      { field: 'id', operator: Operator.equals, value: 'u1' },
      { field: 'name', operator: Operator.equals, value: 'Ann' },
    ]);
    const rule = {
      field: 'tagAttachments',
      arrayOperator: 'any',
      condition: { field: 'tag.name', operator: Operator.equals, value: 'vip' },
    };
    const composed = narrowRule(rule as never, twice);
    const row = (id: string, name: string) => ({
      id,
      name,
      tagAttachments: [attachment(null, { id: 't', name: 'vip', ownerModel: 'platform' })],
    });
    expect(check(composed, row('u1', 'Ann'))).toBe(true);
    expect(check(composed, row('u1', 'Bob'))).not.toBe(true);
    expect(check(composed, row('u2', 'Ann'))).not.toBe(true);
  });

  test('narrowRule folds all three layers: liveness, ownership and target each decide', () => {
    const rule = {
      field: 'tagAttachments',
      arrayOperator: 'any',
      condition: { field: 'tag.name', operator: Operator.equals, value: 'vip' },
    };
    const composed = narrowRule(rule as never, targeted);
    const own = { id: 't1', name: 'vip', ownerModel: 'Organization', organizationId: 'org-1' };
    const theirs = { id: 't2', name: 'vip', ownerModel: 'Organization', organizationId: 'org-2' };
    const platform = { id: 't3', name: 'vip', ownerModel: 'platform' };

    expect(check(composed, { id: 'u1', tagAttachments: [attachment(null, own)] })).toBe(true);
    expect(check(composed, { id: 'u1', tagAttachments: [attachment(null, platform)] })).toBe(true);
    expect(check(composed, { id: 'u1', tagAttachments: [attachment(null, theirs)] })).not.toBe(
      true,
    );
    expect(check(composed, { id: 'u1', tagAttachments: [attachment('2026-01-01', own)] })).not.toBe(
      true,
    );
    expect(check(composed, { id: 'u2', tagAttachments: [attachment(null, own)] })).not.toBe(true);
  });
});
