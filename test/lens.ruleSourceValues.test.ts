import { describe, expect, test } from 'bun:test';
import { ruleSourceValues } from '../src/lens/ruleSourceValues';
import type { Lens, LensNarrowing } from '../src/lens/types';
import type { FieldMap } from '../src/toPrisma/types';
import type { Condition } from '../src/types';

const map: FieldMap = {
  models: {
    User: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        tier: { kind: 'scalar', type: 'String' },
        meta: { kind: 'scalar', type: 'Json' },
        account: { kind: 'object', type: 'Account' },
        tagAttachments: { kind: 'object', type: 'TagAttachment', isList: true },
      },
    },
    Account: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        active: { kind: 'scalar', type: 'Boolean' },
      },
    },
    TagAttachment: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        createdAt: { kind: 'scalar', type: 'DateTime' },
        tag: { kind: 'object', type: 'Tag' },
      },
    },
    Tag: {
      fields: {
        id: { kind: 'scalar', type: 'String' },
        name: { kind: 'scalar', type: 'String' },
      },
    },
  },
};

const lens: Lens = { maps: { app: map }, mapName: 'app', model: 'User' };

const narrowing: LensNarrowing = {
  parent: lens,
  root: {
    sources: { tier: true },
    relations: {
      account: {},
      tagAttachments: { relations: { tag: { sources: { id: true } } } },
    },
  },
};

const tagSource = { path: 'User.tagAttachments.tag', mapName: 'app', model: 'Tag', field: 'id' };

describe('ruleSourceValues — the values a rule names at each declared source', () => {
  test('nested relation spelling reaches the source through the relation node', () => {
    const rule: Condition = {
      field: 'tagAttachments',
      arrayOperator: 'any',
      condition: { field: 'tag.id', operator: 'in', value: ['a', 'b'] },
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: ['a', 'b'], dynamic: false },
    ]);
  });

  test('dotted spelling is the same path', () => {
    const rule: Condition = { field: 'tagAttachments.tag.id', operator: 'equals', value: 'a' };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: ['a'], dynamic: false },
    ]);
  });

  test('quantifier- and operator-blind: none / notIn name their values too', () => {
    const rule: Condition = {
      all: [
        {
          field: 'tagAttachments',
          arrayOperator: 'none',
          condition: { field: 'tag.id', operator: 'equals', value: 'a' },
        },
        { field: 'tagAttachments.tag.id', operator: 'notIn', value: ['b', 'a'] },
      ],
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: ['a', 'b'], dynamic: false },
    ]);
  });

  test('a path / bind leaf marks the source dynamic and contributes no value', () => {
    const rule: Condition = {
      any: [
        { field: 'tagAttachments.tag.id', operator: 'equals', path: 'account.id' },
        { field: 'tier', operator: 'equals', bind: 'tier' },
      ],
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: [], dynamic: true },
      { path: 'User', mapName: 'app', model: 'User', field: 'tier', values: [], dynamic: true },
    ]);
  });

  test('operators that take no value contribute nothing, even with value: true', () => {
    const rule: Condition = {
      all: [
        { field: 'tagAttachments.tag.id', operator: 'exists', value: true },
        { field: 'tier', operator: 'isEmpty', value: true },
      ],
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: [], dynamic: false },
      { path: 'User', mapName: 'app', model: 'User', field: 'tier', values: [], dynamic: false },
    ]);
  });

  test('undeclared sources are silent: a field without a source, a relation the narrowing omits', () => {
    const rule: Condition = {
      all: [
        { field: 'tagAttachments.tag.name', operator: 'equals', value: 'vip' },
        { field: 'account.active', operator: 'equals', value: true },
        { field: 'meta.tag.id', operator: 'equals', value: 'a' },
      ],
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([]);
  });

  test('a windowing filter is walked at the relation anchor; the aggregate threshold is not a source value', () => {
    const rule: Condition = {
      field: 'tagAttachments',
      aggregate: { mode: 'sum', field: 'weight' },
      filter: { field: 'tag.id', operator: 'equals', value: 'a' },
      operator: 'greaterThan',
      value: 2,
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: ['a'], dynamic: false },
    ]);
  });

  test('if / then / else descend', () => {
    const rule: Condition = {
      if: { field: 'tier', operator: 'equals', value: 'gold' },
      then: { field: 'tagAttachments.tag.id', operator: 'equals', value: 'a' },
      else: { field: 'tagAttachments.tag.id', operator: 'equals', value: 'b' },
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      {
        path: 'User',
        mapName: 'app',
        model: 'User',
        field: 'tier',
        values: ['gold'],
        dynamic: false,
      },
      { ...tagSource, values: ['a', 'b'], dynamic: false },
    ]);
  });

  test('a bare lens declares no sources', () => {
    const rule: Condition = { field: 'tagAttachments.tag.id', operator: 'equals', value: 'a' };
    expect(ruleSourceValues(lens, rule)).toEqual([]);
  });

  test('a prototype-named field is not a source', () => {
    const rule: Condition = { field: 'toString', operator: 'equals', value: 'a' };
    expect(ruleSourceValues(narrowing, rule)).toEqual([]);
  });
});

describe('ruleSourceValues — adversarial round (2.20.0 fix set)', () => {
  test('a mapDefaults-declared source answers wherever its model appears, with no root.relations spelling', () => {
    const byDefaults: LensNarrowing = {
      parent: lens,
      mapDefaults: { app: { models: { Tag: { sources: { id: true } } } } },
    };
    const rule: Condition = { field: 'tagAttachments.tag.id', operator: 'in', value: ['t1', 't2'] };
    expect(ruleSourceValues(byDefaults, rule)).toEqual([
      { ...tagSource, values: ['t1', 't2'], dynamic: false },
    ]);
  });

  test('non-enumerating shapes mark the source dynamic instead of inventing values: between, contains, matches', () => {
    const rules: Condition[] = [
      { field: 'tagAttachments.tag.id', operator: 'between', value: ['a', 'z'] },
      { field: 'tagAttachments.tag.id', operator: 'contains', value: 'gol' },
      { field: 'tagAttachments.tag.id', operator: 'matches', value: '^gold$' },
    ];
    for (const rule of rules) {
      expect(ruleSourceValues(narrowing, rule)).toEqual([
        { ...tagSource, values: [], dynamic: true },
      ]);
    }
  });

  test('an operator the catalog does not know fails closed', () => {
    const rule = {
      field: 'tier',
      operator: 'definitelyNotAnOperator',
      value: 'x',
    } as unknown as Condition;
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { path: 'User', mapName: 'app', model: 'User', field: 'tier', values: [], dynamic: true },
    ]);
  });

  test('path: undefined is a literal leaf, not a dynamic one', () => {
    const rule = {
      field: 'tier',
      operator: 'equals',
      value: 'gold',
      path: undefined,
      bind: undefined,
    } as unknown as Condition;
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      {
        path: 'User',
        mapName: 'app',
        model: 'User',
        field: 'tier',
        values: ['gold'],
        dynamic: false,
      },
    ]);
  });

  test('a stray variable key is data, not a value source', () => {
    const rule = {
      field: 'tier',
      operator: 'equals',
      value: 'gold',
      variable: {},
    } as unknown as Condition;
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      {
        path: 'User',
        mapName: 'app',
        model: 'User',
        field: 'tier',
        values: ['gold'],
        dynamic: false,
      },
    ]);
  });

  test('structured values dedupe by content: equal Dates and equal object literals collapse', () => {
    const day = () => new Date(1735689600000);
    const rule: Condition = {
      all: [
        { field: 'tier', operator: 'equals', value: day() },
        { field: 'tier', operator: 'equals', value: day() },
        { field: 'tier', operator: 'in', value: [{ a: 1 }, { a: 1 }] },
      ],
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      {
        path: 'User',
        mapName: 'app',
        model: 'User',
        field: 'tier',
        values: [day(), { a: 1 }],
        dynamic: false,
      },
    ]);
  });

  test('a null inside an in list is a named value', () => {
    const rule = { field: 'tier', operator: 'in', value: ['a', null] } as unknown as Condition;
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      {
        path: 'User',
        mapName: 'app',
        model: 'User',
        field: 'tier',
        values: ['a', null],
        dynamic: false,
      },
    ]);
  });

  test('an array count arm contributes neither a value nor dynamic', () => {
    const rule: Condition = {
      field: 'tagAttachments',
      arrayOperator: 'exactly',
      count: 0,
      condition: { field: 'tag.id', operator: 'equals', value: 'a' },
    };
    expect(ruleSourceValues(narrowing, rule)).toEqual([
      { ...tagSource, values: ['a'], dynamic: false },
    ]);
  });
});
