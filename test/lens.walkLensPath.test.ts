import { describe, expect, test } from 'bun:test';
import type { FieldMapSet } from '../src/fieldMap/types';
import type { Lens, LensNarrowing } from '../src/lens/types';
import { validateRuleInLens } from '../src/lens/validateRuleInLens';
import { walkLensPath } from '../src/lens/walkLensPath';
import { Operator } from '../src/operator';

const maps: FieldMapSet['maps'] = {
  app: {
    models: {
      User: {
        fields: {
          name: { kind: 'scalar', type: 'String' },
          meta: { kind: 'scalar', type: 'Json' },
          posts: {
            kind: 'object',
            type: 'Post',
            isList: true,
            relationName: 'UserPosts',
            fromFields: [],
            toFields: [],
          },
          org: {
            kind: 'bridge',
            type: 'crm:Org',
            relationName: 'UserOrg',
            fromFields: [],
            toFields: [],
          },
        },
      },
      Post: {
        fields: {
          title: { kind: 'scalar', type: 'String' },
          author: {
            kind: 'object',
            type: 'User',
            relationName: 'PostAuthor',
            fromFields: [],
            toFields: [],
          },
        },
      },
    },
  },
  crm: {
    models: {
      Org: {
        fields: {
          id: { kind: 'scalar', type: 'String' },
          label: { kind: 'scalar', type: 'String' },
        },
      },
    },
  },
};

const bare: Lens = { maps, mapName: 'app', model: 'User' };

const narrowed: LensNarrowing = {
  parent: bare,
  root: { picks: ['name', 'posts'], relations: { posts: { picks: ['title'] } } },
};

describe('walkLensPath — one dotted path through the lens, verified hop by hop', () => {
  test('a scalar, a relation terminal, and a bridge into another map all resolve with their hops', () => {
    const scalar = walkLensPath(bare, 'posts.title');
    expect(scalar.outcome).toBe('resolved');
    if (scalar.outcome !== 'resolved') return;
    expect(scalar.hops.map((hop) => [hop.field, hop.modelName, hop.relPath])).toEqual([
      ['posts', 'User', []],
      ['title', 'Post', ['posts']],
    ]);
    expect(scalar.terminal.entry.kind).toBe('scalar');

    const relation = walkLensPath(bare, 'posts.author');
    expect(relation.outcome).toBe('resolved');
    if (relation.outcome === 'resolved') expect(relation.terminal.entry.kind).toBe('object');

    const bridged = walkLensPath(bare, 'org.label');
    expect(bridged.outcome).toBe('resolved');
    if (bridged.outcome === 'resolved') expect(bridged.terminal.mapName).toBe('crm');
  });

  test('a path below a Json column resolves at the column and carries the remainder', () => {
    const below = walkLensPath(bare, 'meta.settings.theme');
    expect(below.outcome).toBe('resolved');
    if (below.outcome !== 'resolved') return;
    expect(below.terminal.field).toBe('meta');
    expect(below.jsonSubPath).toEqual(['settings', 'theme']);
  });

  test('missing is a column the model lacks, pastScalar a segment after a scalar — each with the index', () => {
    expect(walkLensPath(bare, 'posts.nope')).toMatchObject({ outcome: 'missing', index: 1 });
    expect(walkLensPath(bare, 'name.length')).toMatchObject({ outcome: 'pastScalar', index: 0 });
    expect(walkLensPath(bare, 'posts.title.length')).toMatchObject({
      outcome: 'pastScalar',
      index: 1,
    });
  });

  test('hidden is a column the model has but the narrowing does not expose at that visit', () => {
    expect(walkLensPath(narrowed, 'meta')).toMatchObject({ outcome: 'hidden', index: 0 });
    expect(walkLensPath(narrowed, 'org.label')).toMatchObject({ outcome: 'hidden', index: 0 });
    expect(walkLensPath(narrowed, 'posts.author.name')).toMatchObject({
      outcome: 'hidden',
      index: 1,
    });
    expect(walkLensPath(narrowed, 'posts.title').outcome).toBe('resolved');
  });

  test('the gate and the walk agree: a hidden path is a violation, a resolved one is not', () => {
    const rule = (field: string) => ({ field, operator: Operator.exists });
    expect(validateRuleInLens(rule('posts.title'), narrowed).ok).toBe(true);
    expect(validateRuleInLens(rule('posts.author.name'), narrowed).ok).toBe(false);
    expect(validateRuleInLens(rule('meta.settings.theme'), bare).ok).toBe(true);
  });
});
